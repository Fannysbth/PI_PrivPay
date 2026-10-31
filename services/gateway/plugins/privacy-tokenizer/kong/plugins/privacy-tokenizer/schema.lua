local typedefs = require("kong.db.schema.typedefs")

-- Configuration of the privacy-tokenizer plugin (DK-02b). Written by the render step of the adapter package from the
-- environment (PRIVACY_MODE, URLs, paths of secret files); no secret value is ever in this configuration.
return {
  name = "privacy-tokenizer",
  fields = {
    { protocols = typedefs.protocols_http },
    {
      config = {
        type = "record",
        fields = {
          { action = { type = "string", required = true, one_of = { "tokenize", "passthrough" } } },
          { privacy_url = { type = "string" } },
          { idp_url = { type = "string" } },
          { client_id = { type = "string", default = "api-gateway" } },
          { client_secret_file = { type = "string" } },
          { edge_secret_file = { type = "string" } },
          { timeout_ms = { type = "integer", default = 3000, between = { 100, 10000 } } },
          { retries = { type = "integer", default = 2, between = { 0, 2 } } },
          -- reason of Privacy -> HTTP status towards the client (ADR-0008), from the table the adapter uses.
          { reasons = { type = "map", keys = { type = "string" }, values = { type = "integer" }, default = {} } },
        },
        entity_checks = {
          { conditional = { if_field = "action", if_match = { eq = "tokenize" },
            then_field = "privacy_url", then_match = { required = true } } },
          { conditional = { if_field = "action", if_match = { eq = "tokenize" },
            then_field = "idp_url", then_match = { required = true } } },
          { conditional = { if_field = "action", if_match = { eq = "tokenize" },
            then_field = "client_secret_file", then_match = { required = true } } },
          { conditional = { if_field = "action", if_match = { eq = "tokenize" },
            then_field = "edge_secret_file", then_match = { required = true } } },
        },
      },
    },
  },
}
