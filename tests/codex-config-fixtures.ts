// Codex config.toml documents and the [marketplaces.planban] source settings they define.
// Every valid case is also valid TOML 1.0 (checked with Python's tomllib), and every invalid case is rejected by it.
export type CodexConfigCase = { name: string; toml: string; expected: { source_type?: string; source?: string } | null };

const local = { source_type: "local", source: "/real" };

export const codexConfigCases: CodexConfigCase[] = [
  {
    name: "standard table",
    toml: String.raw`model = "x"

[marketplaces.planban]
source_type = "local"
source = "/real"

[marketplaces.paper]
source_type = "git"
source = "/paper"
`,
    expected: local,
  },
  {
    name: "multiline basic string after the real source",
    toml: String.raw`[marketplaces.planban]
source_type = "local"
source = "/real"
notes = """
[marketplaces.planban]
source = "/decoy"
"""
`,
    expected: local,
  },
  {
    name: "multiline literal string after the real source",
    toml: String.raw`[marketplaces.planban]
source_type = "local"
source = "/real"
notes = '''
source = "/decoy"
'''
`,
    expected: local,
  },
  {
    name: "multiline string in another table naming a decoy table",
    toml: String.raw`[marketplaces.paper]
source_type = "local"
notes = """
[marketplaces.planban]
source_type = "local"
source = "/decoy" """
`,
    expected: null,
  },
  {
    name: "array spanning lines with string and comment decoys",
    toml: String.raw`[marketplaces.planban]
tags = [
  "a", # source = "/decoy"
  """
source = "/decoy"
""",
  ['''
source_type = "git"
'''],
]
source_type = "local"
source = "/real"
`,
    expected: local,
  },
  {
    name: "top-level dotted keys",
    toml: String.raw`marketplaces.planban.source_type = "local"
marketplaces . planban . source = "/real"
`,
    expected: local,
  },
  {
    name: "dotted keys under [marketplaces]",
    toml: String.raw`[marketplaces]
planban.source_type = "local"
planban.source = "/real"
`,
    expected: local,
  },
  {
    name: "inline table under [marketplaces]",
    toml: String.raw`[marketplaces]
paper = { source_type = "git", source = "/paper" }
planban = { source_type = "local", source = "/real", tags = ["a", { b = 1 }] }
`,
    expected: local,
  },
  {
    name: "quoted keys and a quoted table name",
    toml: String.raw`[ marketplaces . "planban" ] # comment
"source_type" = 'local'
'source' = "/real"
`,
    expected: local,
  },
  {
    name: "unicode escapes, including \\U",
    toml: String.raw`[marketplaces.planban]
source_type = "loc\u0061l"
source = "/re\U0001F600al\t"
`,
    expected: { source_type: "local", source: "/re\u{1F600}al\t" },
  },
  {
    name: "multiline basic string with a line-ending backslash",
    toml: String.raw`[marketplaces.planban]
source_type = "local"
source = """
/re\
      al"""
`,
    expected: local,
  },
  {
    name: "Windows paths in literal and escaped basic strings",
    toml: String.raw`[marketplaces.planban]
source_type = 'local'
source = 'C:\Users\me\release'
backup = "C:\\Users\\me\\release"
`,
    expected: { source_type: "local", source: String.raw`C:\Users\me\release` },
  },
  {
    name: "CRLF line endings and comments",
    toml: "# Codex config\r\n[marketplaces.planban] # local\r\nsource_type = \"local\" # type\r\nsource = \"/real\"\r\n",
    expected: local,
  },
  {
    name: "non-string values and arrays of tables",
    toml: String.raw`count = 3
ratio = -1.5e3
enabled = true
offset = 0x1F
when = 1979-05-27 07:32:00Z

[marketplaces.planban]
last_updated = 2026-10-11T10:00:00Z
source_type = "local"
source = "/real"

[[profiles]]
source = "/decoy"

[[profiles]]
source = "/decoy"
`,
    expected: local,
  },
  {
    name: "source is not a string",
    toml: String.raw`[marketplaces.planban]
source_type = "local"
source = ["/real"]
`,
    expected: { source_type: "local" },
  },
  { name: "no planban marketplace", toml: "[marketplaces.paper]\nsource = \"/paper\"\n", expected: null },
  { name: "empty file", toml: "", expected: null },
  { name: "unterminated table header", toml: "[marketplaces.planban\nsource_type = \"local\"\nsource = \"/real\"\n", expected: null },
  { name: "unterminated multiline string", toml: "[marketplaces.planban]\nsource_type = \"local\"\nsource = \"/real\"\nnotes = \"\"\"\n", expected: null },
  { name: "duplicate key", toml: "[marketplaces.planban]\nsource_type = \"local\"\nsource = \"/real\"\nsource = \"/decoy\"\n", expected: null },
  { name: "invalid escape", toml: "[marketplaces.planban]\nsource_type = \"local\"\nsource = \"C:\\Users\"\n", expected: null },
  { name: "bare value", toml: "[marketplaces.planban]\nsource_type = local\nsource = \"/real\"\n", expected: null },
  {
    name: "table reopened later in the file",
    toml: "[marketplaces.planban]\nsource_type = \"local\"\n\n[marketplaces.paper]\n\n[marketplaces.planban]\nsource = \"/decoy\"\n",
    expected: null,
  },
  {
    name: "inline table reopened by a header",
    toml: "[marketplaces]\nplanban = { source_type = \"local\" }\n\n[marketplaces.planban]\nsource = \"/decoy\"\n",
    expected: null,
  },
  { name: "inline table extended by a dotted key", toml: "marketplaces.planban = { source_type = \"local\" }\nmarketplaces.planban.source = \"/decoy\"\n", expected: null },
  {
    name: "table made by dotted keys reopened by a header",
    toml: "marketplaces.planban.source_type = \"local\"\n\n[marketplaces.planban]\nsource = \"/decoy\"\n",
    expected: null,
  },
  {
    name: "table made by a header extended by dotted keys from a parent header",
    toml: "[marketplaces.planban]\nsource_type = \"local\"\n\n[marketplaces]\nplanban.source = \"/decoy\"\n",
    expected: null,
  },
  { name: "array reopened as an array of tables", toml: "marketplaces = []\n\n[[marketplaces]]\nsource = \"/decoy\"\n", expected: null },
  { name: "array of tables reopened as a table", toml: "[[profiles]]\n[profiles]\n[marketplaces.planban]\nsource_type = \"local\"\nsource = \"/real\"\n", expected: null },
  {
    name: "parent declared after its child, and sub-tables under dotted and header tables",
    toml: String.raw`[marketplaces.planban.extra]
[marketplaces]
paper.source = "/paper"
[marketplaces.paper.extra]
[marketplaces.planban]
source_type = "local"
source = "/real"
nested.value = 1
[marketplaces.planban.nested.deeper]
`,
    expected: local,
  },
  { name: "control character in a comment", toml: "# \u0007\n[marketplaces.planban]\nsource_type = \"local\"\nsource = \"/real\"\n", expected: null },
  { name: "TOML 1.1 escape", toml: "[marketplaces.planban]\nsource_type = \"local\"\nsource = \"/re\\x61l\"\n", expected: null },
  { name: "multi-line inline table", toml: "[marketplaces]\nplanban = {\n  source_type = \"local\", source = \"/real\" }\n", expected: null },
  { name: "inline table trailing comma", toml: "[marketplaces]\nplanban = { source_type = \"local\", source = \"/real\", }\n", expected: null },
  ...[
    "2024-02-29", "1979-05-27T07:32:00.999-08:00", "1979-05-27 07:32:00z", "07:32:00.5", "0", "-0", "+1_000", "0x1F_ab", "0o17",
    "0b1_01", "1_000.5e-0_3", "1e05", "-inf", "+nan", "true",
  ].map((scalar): CodexConfigCase => ({
    name: `valid scalar ${scalar}`,
    toml: `when = ${scalar}\n[marketplaces.planban]\nsource_type = "local"\nsource = "/real"\n`,
    expected: local,
  })),
  ...[
    "123garbage", "01", "2026-99-99", "2023-02-29", "2023-04-31", "0000-01-01", "1979-05-27T24:00:00", "1979-05-27T07:60:00",
    "1979-05-27T07:32:60", "1979-05-27T07:32", "1979-05-27T07:32:00+24:00", "1979-05-27T07:32:00.", "1979-5-27", "7:32:00",
    "0x_1", "+0x1", "0b2", "1__0", "_1", "1_", "1.", ".1", "1.e5", "1e", "1e_5", "00.1", "Inf", "NaN", "True",
  ].map((scalar): CodexConfigCase => ({
    name: `invalid scalar ${scalar}`,
    toml: `when = ${scalar}\n[marketplaces.planban]\nsource_type = "local"\nsource = "/real"\n`,
    expected: null,
  })),
];
