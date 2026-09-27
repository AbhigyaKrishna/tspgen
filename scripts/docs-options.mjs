// Renders the README "Options reference" tables from each package's options schema and feature definitions.
// `pnpm docs:options` builds the packages and rewrites README.md between the markers below.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const START = "<!-- options:start -->";
const END = "<!-- options:end -->";

const load = (pkg) => import(pathToFileURL(resolve(ROOT, "packages", pkg, "dist/index.js")).href);
const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ");
const code = (value) => `\`${typeof value === "string" ? value : JSON.stringify(value)}\``;

function kind(schema) {
  if (Array.isArray(schema.enum)) return schema.enum.map(code).join(" \\| ");
  if (schema.type === "array") return schema.items?.type === "string" ? "string[]" : "list";
  return schema.type ?? "any";
}

function optionRows(schema, skip) {
  return Object.entries(schema.properties ?? {})
    .filter(([key]) => !skip.has(key))
    .map(([key, s]) => [code(key), kind(s), s.default === undefined ? "—" : code(s.default), "—", cell(s.description ?? "")]);
}

function featureRows(defs) {
  return Object.entries(defs).map(([key, def]) => [
    code(`features.${key}`),
    "feature",
    code(def.default),
    def.override ? def.override : "—",
    cell(def.description),
  ]);
}

function table(title, rows) {
  return [
    `### ${title}`,
    "",
    "| Key | Kind | Default | `@meta` override | Description |",
    "|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ].join("\n");
}

export async function optionsReference() {
  const core = await load("core");
  const kotlin = await load("kotlin");
  const typescript = await load("typescript");
  const server = (await load("kotlin-ktor-server")).default;
  const client = (await load("kotlin-ktor-client")).default;
  const next = (await load("ts-nextjs-client")).default;
  const language = (lib, features, moved) => [
    ...optionRows(
      lib.emitter.options,
      new Set(["targets", "features", ...Object.keys(core.coreMovedOptions), ...Object.keys(moved)]),
    ),
    ...featureRows(features.defs),
  ];
  const target = (t) => [...optionRows(t.optionsSchema ?? {}, new Set(["features"])), ...(t.features ? featureRows(t.features.defs) : [])];
  return [
    table("`@abhigyakrishna/tspgen-kotlin`", language(kotlin.$lib, kotlin.kotlinFeatures, kotlin.kotlinMovedOptions)),
    table("`@abhigyakrishna/tspgen-kotlin-ktor-server` (target)", target(server)),
    table("`@abhigyakrishna/tspgen-kotlin-ktor-client` (target)", target(client)),
    table("`@abhigyakrishna/tspgen-typescript`", language(typescript.$lib, typescript.typescriptFeatures, typescript.typescriptMovedOptions)),
    table("`@abhigyakrishna/tspgen-ts-nextjs-client` (target)", target(next)),
  ].join("\n");
}

/** `readme` with `reference` between the options markers. */
export function withOptionsReference(readme, reference) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start) throw new Error(`README.md needs ${START} and ${END} markers`);
  return `${readme.slice(0, start + START.length)}\n\n${reference}\n${readme.slice(end)}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = resolve(ROOT, "README.md");
  writeFileSync(path, withOptionsReference(readFileSync(path, "utf8"), await optionsReference()));
}
