# Portable themes

Scripture Journal themes are data-only TOML files. Choose **Import theme** in the
header, select a `.toml` file, and the validated theme becomes the active,
device-local appearance. Importing the same `id` replaces the prior copy.

The format has `schema_version = 1`, a lowercase letters/numbers/hyphens `id`, a
display `name`, `mode = "light"` or `"dark"`, and every color shown in
[`themes/forest-night.toml`](themes/forest-night.toml). Colors must be quoted,
six-digit hex values. Unknown fields, incomplete palettes, CSS, URLs, functions,
and files larger than 64 KB are rejected. A rejected file leaves the current
appearance unchanged.

The portable format intentionally supports a small TOML subset: one `[colors]`
table, double-quoted single-line strings, and whole-line comments. Use the example
as a starting point; arbitrary TOML tables, multiline values, and inline comments
are not part of this version of the portable format.

On Linux desktop installations, **Follow Omarchy** reads the active palette from
`~/.local/state/omarchy/current/theme/colors.toml`. It never changes Omarchy. The
app checks for changes every three seconds while that choice is active and keeps
the last usable palette if a new file is missing or malformed. Portable imported
themes work on Linux and macOS and do not depend on Omarchy.
