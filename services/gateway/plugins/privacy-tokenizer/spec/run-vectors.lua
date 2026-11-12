-- Runs the contract vectors of tests/security/gateway-contract against core.lua (DK-02b). Used by the Jest test
-- `pnpm test:edge`, inside a throwaway container of the pinned Kong image:
--   resty run-vectors.lua <vectors.json>     (reads a JSON list of filled vectors, prints a JSON list of results)
package.path = "/plugin/kong/plugins/privacy-tokenizer/?.lua;" .. package.path

local cjson = require("cjson.safe").new()
cjson.encode_number_precision(16)
local core = require("core")

local file = assert(io.open(arg[1], "r"))
local vectors = assert(cjson.decode(file:read("*a")))
file:close()

local results = {}
for index, vector in ipairs(vectors) do
  local calls = 0
  local batches = 0
  local function privacy(request)
    calls = calls + 1
    local key = request.subject_type .. ":" .. request.subject_id
    local failure = vector.privacy.errors[key]
    if failure ~= nil then
      return nil, failure
    end
    local pseudonym = vector.privacy.pseudonyms[key]
    if pseudonym == nil then
      return nil, "INTERNAL_ERROR"
    end
    return pseudonym
  end

  -- ADR-0019: the pair of a payment in one call. Every request counts as asked (as before), and the first refusal
  -- refuses the lot (all or nothing); the order of the answers is the order of the requests.
  local function privacy_batch(requests)
    batches = batches + 1
    local tokens, failed, failure = {}, false, nil
    for position, request in ipairs(requests) do
      local pseudonym, why = privacy(request)
      if pseudonym == nil and not failed then
        failed, failure = true, why
      end
      tokens[position] = pseudonym
    end
    if failed then
      return nil, failure
    end
    return tokens
  end

  local outbound, reason = core.tokenize({
    route = vector.route,
    claims = vector.claims,
    body = vector.body,
    idempotency_key = vector.idempotency_key,
    transaction_id = vector.transaction_id or "TX-1",
  }, privacy, privacy_batch)
  results[index] = {
    name = vector.name, outbound = outbound, error = reason, privacy_calls = calls, privacy_batches = batches,
  }
end

io.write(cjson.encode(results))
