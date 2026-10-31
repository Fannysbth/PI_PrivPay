-- The tokenizing step of the gateway as a pure function (DK-02b, gateway spec 4, 5, 9; Metodologi, privacy-tokenizer).
-- No Kong, no ngx, no I/O here except the `privacy` function handed in, so the contract vectors of
-- tests/security/gateway-contract run against exactly this code. Every raw identifier of a request goes to `privacy`
-- and nowhere else; the table returned is built field by field from an allow list, never by deleting from the input.
--
-- The checks below are the light mirror of the schemas of the adapter (services/gateway/src/tokenizer/schemas.ts):
-- they decide only whether tokens may be asked for. The adapter validates again and stays the authority.
local core = {}

local MAX_SAFE = 9007199254740991
local MAX_SETTLEMENT_ITEMS = 500

local UUID = "^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"

local function is_string(value, min, max)
  return type(value) == "string" and #value >= min and #value <= max
end

local function is_amount(value)
  return type(value) == "number" and value == math.floor(value) and value >= 1 and value <= MAX_SAFE
end

local function matches(value, min, max, pattern)
  return is_string(value, min, max) and value:match(pattern) ~= nil
end

local function is_account(value)
  return matches(value, 8, 20, "^%d+$")
end

local function is_date(value)
  if not matches(value, 10, 10, "^%d%d%d%d%-%d%d%-%d%d$") then
    return false
  end
  local year, month, day = tonumber(value:sub(1, 4)), tonumber(value:sub(6, 7)), tonumber(value:sub(9, 10))
  if month < 1 or month > 12 or day < 1 then
    return false
  end
  local days = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }
  if year % 4 == 0 and (year % 100 ~= 0 or year % 400 == 0) then
    days[2] = 29
  end
  return day <= days[month]
end

-- True when `tbl` is a JSON object whose keys are all in `allowed` and all of `required` are present.
local function has_keys(tbl, allowed, required)
  if type(tbl) ~= "table" then
    return false
  end
  for key in pairs(tbl) do
    if allowed[key] ~= true then
      return false
    end
  end
  for _, key in ipairs(required) do
    if tbl[key] == nil then
      return false
    end
  end
  return true
end

local TRANSACTION_KEYS = {
  source_account = true, merchant_id = true, amount = true, geohash = true, nik = true, nama = true, email = true,
}
local TRANSACTION_REQUIRED = { "source_account", "merchant_id", "amount", "geohash" }

local function valid_transaction(body)
  return has_keys(body, TRANSACTION_KEYS, TRANSACTION_REQUIRED)
    and is_account(body.source_account)
    and matches(body.merchant_id, 7, 64, "^MRC%-%d+$")
    and is_amount(body.amount)
    and matches(body.geohash, 1, 12, "^[0-9b-hjkmnp-z]+$")
    and (body.nik == nil or is_string(body.nik, 0, 64))
    and (body.nama == nil or is_string(body.nama, 0, 200))
    and (body.email == nil or is_string(body.email, 0, 200))
end

local ITEM_KEYS = { account_number = true, amount = true, bank_reference = true }
local ITEM_REQUIRED = { "account_number", "amount", "bank_reference" }

local function valid_settlement(body)
  if not has_keys(body, { batch_date = true, items = true }, { "batch_date", "items" }) then
    return false
  end
  if not is_date(body.batch_date) or type(body.items) ~= "table" then
    return false
  end
  local count = #body.items
  if count < 1 or count > MAX_SETTLEMENT_ITEMS then
    return false
  end
  -- Every key must be 1..count: an object with other keys is not a list.
  for key in pairs(body.items) do
    if type(key) ~= "number" or key < 1 or key > count or key ~= math.floor(key) then
      return false
    end
  end
  for index = 1, count do
    local item = body.items[index]
    if not (has_keys(item, ITEM_KEYS, ITEM_REQUIRED)
      and is_account(item.account_number)
      and is_amount(item.amount)
      and matches(item.bank_reference, 1, 32, "^[A-Z0-9%-]+$")) then
      return false
    end
  end
  return true
end

local function valid_notification(body)
  return has_keys(body, { phone = true, channel = true }, { "phone", "channel" })
    and matches(body.phone, 10, 14, "^08%d+$")
    and body.channel == "SMS"
end

local function transaction(input, privacy)
  if not valid_transaction(input.body) then
    return nil, "VALIDATION_ERROR"
  end
  if not matches(input.idempotency_key, 36, 36, UUID) then
    return nil, "VALIDATION_ERROR"
  end
  -- A generator that breaks the format is a fault of ours, not of the client.
  if not matches(input.transaction_id, 4, 32, "^TX%-%d+$") then
    return nil, "INTERNAL_ERROR"
  end
  local body = input.body
  -- Both are asked even when the first is refused, as the adapter does; the other token may already exist, which is
  -- harmless because a retry reuses it, and nothing is forwarded (gateway spec 4).
  local customer_token, customer_reason = privacy({
    subject_type = "CUSTOMER", subject_id = input.claims.customer_id,
    target_service = "TRANSACTION", purpose = "PAYMENT_PROCESSING", transaction_id = input.transaction_id,
  })
  local account_token, account_reason = privacy({
    subject_type = "ACCOUNT", subject_id = body.source_account,
    target_service = "TRANSACTION", purpose = "PAYMENT_PROCESSING", transaction_id = input.transaction_id,
  })
  if not customer_token then
    return nil, customer_reason
  end
  if not account_token then
    return nil, account_reason
  end
  -- nik, nama and email are not read: in the proposed condition they do not leave (FR-03).
  return {
    transaction_id = input.transaction_id,
    idempotency_key = input.idempotency_key,
    customer_token = customer_token,
    account_token = account_token,
    merchant_id = body.merchant_id,
    amount = body.amount,
    geohash = body.geohash,
  }
end

local function settlement(input, privacy)
  -- The whole report is checked first, so an invalid item leaves no token behind (FR-32, TF-13).
  if not valid_settlement(input.body) then
    return nil, "VALIDATION_ERROR"
  end
  local tokens = {}
  for _, item in ipairs(input.body.items) do
    if tokens[item.account_number] == nil then
      local token, reason = privacy({
        subject_type = "ACCOUNT", subject_id = item.account_number,
        target_service = "RECONCILIATION", purpose = "DAILY_RECONCILIATION",
      })
      if not token then
        return nil, reason
      end
      tokens[item.account_number] = token
    end
  end
  local items = {}
  for index, item in ipairs(input.body.items) do
    items[index] = {
      account_pseudonym = tokens[item.account_number], amount = item.amount, bank_reference = item.bank_reference,
    }
  end
  return { batch_date = input.body.batch_date, items = items }
end

local function notification(input, privacy)
  if not valid_notification(input.body) then
    return nil, "VALIDATION_ERROR"
  end
  local token, reason = privacy({
    subject_type = "CUSTOMER", subject_id = input.claims.customer_id,
    target_service = "NOTIFICATION", purpose = "NOTIFICATION_REGISTRATION",
  })
  if not token then
    return nil, reason
  end
  return { notification_domain_id = token, phone = input.body.phone, channel = "SMS" }
end

local ROUTES = { transaction = transaction, settlement = settlement, notification = notification }

--- Replaces the raw identifiers of a request by tokens.
-- input: { route = "transaction"|"settlement"|"notification", claims = { customer_id = string }, body = table,
--          idempotency_key = string, transaction_id = string }
-- privacy: function(request) -> pseudonym | nil, reason
-- Returns the outbound table, or nil and a reason. "VALIDATION_ERROR" means nothing was asked of Privacy.
function core.tokenize(input, privacy)
  local run = ROUTES[input.route]
  if run == nil then
    return nil, "INTERNAL_ERROR"
  end
  return run(input, privacy)
end

return core
