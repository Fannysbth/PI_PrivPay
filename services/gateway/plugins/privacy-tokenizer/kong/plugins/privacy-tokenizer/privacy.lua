-- The client of the plugin for the Privacy Service (DK-02b, gateway spec 4 step 3). It asks for a pseudonym with the
-- service token of the gateway client (`api-gateway`, audience `privacy-service`), as the adapter does. K_token is not
-- here: the pseudonym is made inside Privacy. Anything that is not a clear answer is a failure, never a fallback
-- to the raw value (invariant 8).
local http = require("resty.http")
local cjson = require("cjson.safe").new()

local privacy = {}

local TOKEN_KEY = "privpay:privacy-tokenizer:service-token"
-- A service token is reused until 30 seconds before it ends (NFR-21).
local TOKEN_MARGIN = 30
local PSEUDONYM_LENGTH = 13

local function read_file(path)
  local handle = io.open(path, "r")
  if not handle then
    return nil
  end
  local content = handle:read("*a")
  handle:close()
  return (content:gsub("%s+$", ""))
end

local function fetch_service_token(conf)
  local secret = read_file(conf.client_secret_file)
  if not secret or secret == "" then
    return nil, "client secret unreadable"
  end
  local client = http.new()
  client:set_timeout(conf.timeout_ms)
  local answer = client:request_uri(conf.idp_url .. "/token", {
    method = "POST",
    headers = { ["Content-Type"] = "application/json" },
    body = cjson.encode({
      grant_type = "client_credentials", client_id = conf.client_id, client_secret = secret,
      audience = { "privacy-service" },
    }),
  })
  if not answer or answer.status ~= 200 then
    return nil, "token request failed"
  end
  local parsed = cjson.decode(answer.body)
  if type(parsed) ~= "table" or type(parsed.access_token) ~= "string" or type(parsed.expires_in) ~= "number" then
    return nil, "token answer invalid"
  end
  local ttl = parsed.expires_in - TOKEN_MARGIN
  if ttl < 1 then
    ttl = math.max(parsed.expires_in / 2, 0.5)
  end
  return parsed.access_token, nil, ttl
end

local function service_token(conf)
  return kong.cache:get(TOKEN_KEY, { neg_ttl = 1 }, fetch_service_token, conf)
end

local function valid_pseudonym(value)
  return type(value) == "string" and #value == PSEUDONYM_LENGTH and value:match("^PSEU%-[0-9A-F]+$") ~= nil
end

-- What a refusal of Privacy means. A reason is believed only from the list the plugin was given (the same table the
-- adapter uses); anything else falls back to the status, and finally to INTERNAL_ERROR.
local function refusal(conf, response)
  local parsed = cjson.decode(response.body)
  local reason = type(parsed) == "table" and type(parsed.error) == "table" and parsed.error.reason or nil
  if type(reason) == "string" and conf.reasons[reason] ~= nil then
    return reason
  end
  if response.status == 429 then
    return "RATE_LIMITED"
  end
  return "INTERNAL_ERROR"
end

--- Asks Privacy for the pseudonym of one subject (POST /pseudonymize, form 1; idempotent, so it may be repeated).
-- request: { subject_type, subject_id, target_service, purpose, transaction_id? }; `refreshed` is internal.
-- Returns the pseudonym, or nil and a reason.
function privacy.pseudonymize(conf, request, refreshed)
  local body = cjson.encode({
    subject_type = request.subject_type, subject_id = request.subject_id,
    target_service = request.target_service, purpose = request.purpose, transaction_id = request.transaction_id,
  })
  for attempt = 0, conf.retries do
    local token = service_token(conf)
    if not token then
      return nil, "SERVICE_UNAVAILABLE"
    end
    local client = http.new()
    client:set_timeout(conf.timeout_ms)
    local response = client:request_uri(conf.privacy_url .. "/pseudonymize", {
      method = "POST",
      headers = { ["Content-Type"] = "application/json", ["Authorization"] = "Bearer " .. token },
      body = body,
      ssl_verify = true,
    })
    if response and response.status == 200 then
      local parsed = cjson.decode(response.body)
      if type(parsed) == "table" and valid_pseudonym(parsed.pseudonym) then
        return parsed.pseudonym
      end
      return nil, "SERVICE_UNAVAILABLE"
    end
    if response and response.status == 401 then
      -- The cached service token may have ended early (a restarted IdP): fetch a new one once, outside the retries.
      -- A second 401 is a fault of our own credentials, not of the client: unavailable, never a refusal.
      if refreshed then
        return nil, "SERVICE_UNAVAILABLE"
      end
      kong.cache:invalidate_local(TOKEN_KEY)
      return privacy.pseudonymize(conf, request, true)
    elseif response and response.status < 500 then
      return nil, refusal(conf, response)
    end
    if attempt < conf.retries then
      ngx.sleep(0.05 * (2 ^ attempt))
    end
  end
  return nil, "SERVICE_UNAVAILABLE"
end

return privacy
