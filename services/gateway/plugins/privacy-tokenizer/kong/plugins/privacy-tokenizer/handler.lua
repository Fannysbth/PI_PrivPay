-- privacy-tokenizer (DK-02b, Metodologi "privacy-tokenizer"): runs after the JWT plugin, replaces the identifiers of
-- the three tokenizing routes by tokens asked of the Privacy Service, and hands the tokenized body to the adapter.
-- Authorization, shapes and error masking stay in the adapter; this plugin acts only when the caller and the
-- identifiers look right, and otherwise leaves the request as it is for the adapter to answer.
--
-- action = passthrough (the baseline condition): nothing is read or changed, the payload goes on as it is (FR-23).
-- action = tokenize (the proposed condition): Privacy not reachable, or refusing: the request ends here
-- (503 or the refusal), nothing raw goes on.
local cjson = require("cjson.safe").new()
cjson.encode_number_precision(16)
local core = require("kong.plugins.privacy-tokenizer.core")
local privacy = require("kong.plugins.privacy-tokenizer.privacy")

local PrivacyTokenizer = { PRIORITY = 800, VERSION = "0.1.0" }

local ROUTES = {
  ["POST /transaction"] = "transaction",
  ["POST /notification/register"] = "notification",
  ["POST /settlement/report"] = "settlement",
}

local edge_secrets = {}

local function edge_secret(path)
  if edge_secrets[path] == nil then
    local handle = io.open(path, "r")
    if not handle then
      return nil
    end
    edge_secrets[path] = (handle:read("*a"):gsub("%s+$", ""))
    handle:close()
  end
  return edge_secrets[path]
end

-- The claims of the token. The JWT plugin has already checked signature and expiry; this only reads.
local function claims_of_request()
  local header = kong.request.get_header("authorization")
  local token = header and header:match("^[Bb]earer%s+([%w%-_%.]+)$")
  local payload = token and token:match("^[%w%-_]+%.([%w%-_]+)%.")
  if not payload then
    return nil
  end
  local standard = (payload:gsub("%-", "+"):gsub("_", "/"))
  standard = standard .. string.rep("=", (4 - #standard % 4) % 4)
  local json = ngx.decode_base64(standard)
  local claims = json and cjson.decode(json)
  return type(claims) == "table" and claims or nil
end

-- The audience the adapter requires of every token it accepts (authenticate, service api-gateway).
local function for_this_gateway(claims)
  local aud = claims.aud
  if aud == "api-gateway" then
    return true
  end
  if type(aud) == "table" then
    for _, value in ipairs(aud) do
      if value == "api-gateway" then
        return true
      end
    end
  end
  return false
end

-- The same split as the adapter's mayCall: a customer for payments and phone changes, the bank for settlement. A token
-- for another audience is left for the adapter to refuse, before any token is asked of Privacy on its behalf.
local function caller_fits(route, claims)
  if not for_this_gateway(claims) then
    return false
  end
  if route == "settlement" then
    return claims.azp == "bank-simulator"
  end
  return claims.azp == "customer-app" and type(claims.customer_id) == "string"
    and #claims.customer_id > 0 and #claims.customer_id <= 64
end

-- K-17: `TX-`, the epoch milliseconds (13 digits) and a counter of 3 digits shared by the workers.
local function next_transaction_id()
  local sequence = ngx.shared.kong:incr("privpay_tx_sequence", 1, 0) or 0
  return string.format("TX-%013.0f%03d", math.floor(ngx.now() * 1000), sequence % 1000)
end

function PrivacyTokenizer.access(_, conf)
  if conf.action ~= "tokenize" then
    return
  end
  -- Whatever the client sent as the secret of Kong is gone before anything else; only this plugin sets it.
  kong.service.request.clear_header("x-edge-auth")

  local route = ROUTES[kong.request.get_method() .. " " .. kong.request.get_path()]
  if route == nil then
    return
  end
  local claims = claims_of_request()
  if claims == nil or not caller_fits(route, claims) then
    return
  end
  local raw = kong.request.get_raw_body()
  local body = raw and cjson.decode(raw)
  if type(body) ~= "table" then
    return
  end
  -- A repeated Idempotency-Key header arrives as a table; it is not a UUID, so the adapter refuses it.
  local key = kong.request.get_headers()["idempotency-key"]
  if type(key) ~= "string" then
    key = nil
  end

  local asked = 0
  local outbound, reason = core.tokenize({
    route = route,
    claims = { customer_id = claims.customer_id },
    body = body,
    idempotency_key = key,
    transaction_id = route == "transaction" and next_transaction_id() or nil,
  }, function(request)
    asked = asked + 1
    return privacy.pseudonymize(conf, request)
  end)

  if not outbound then
    if reason == "VALIDATION_ERROR" and asked == 0 then
      -- Nothing was valid enough to ask for a token: the adapter answers (422), and no raw value goes on as valid.
      return
    end
    kong.log.warn("privacy-tokenizer: no tokens (", tostring(reason), ")")
    return kong.response.exit(conf.reasons[reason] or 503, { message = "tokenizing refused" })
  end

  local secret = edge_secret(conf.edge_secret_file)
  if not secret or secret == "" then
    kong.log.err("privacy-tokenizer: the secret shared with the adapter is unreadable")
    return kong.response.exit(503, { message = "tokenizing unavailable" })
  end
  kong.service.request.set_raw_body(cjson.encode(outbound))
  kong.service.request.set_header("content-type", "application/json")
  kong.service.request.set_header("x-edge-auth", secret)
end

return PrivacyTokenizer
