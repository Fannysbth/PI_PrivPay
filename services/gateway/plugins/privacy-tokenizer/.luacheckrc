-- luacheck for the plugin (DK-02b). Kong and OpenResty provide these globals; nothing else is allowed to be global.
std = "ngx_lua"
globals = {}
read_globals = { "kong", "ngx" }
max_line_length = 120
exclude_files = {}
