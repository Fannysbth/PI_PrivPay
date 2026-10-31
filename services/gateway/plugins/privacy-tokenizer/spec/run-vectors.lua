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

  local outbound, reason = core.tokenize({
    route = vector.route,
    claims = vector.claims,
    body = vector.body,
    idempotency_key = vector.idempotency_key,
    transaction_id = vector.transaction_id or "TX-1",
  }, privacy)
  results[index] = { name = vector.name, outbound = outbound, error = reason, privacy_calls = calls }
end

io.write(cjson.encode(results))
