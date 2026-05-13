import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const packageDirs = (await readdir("packages", { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join("packages", entry.name));

const failures = [];
for (const dir of packageDirs) {
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  if (!pkg.name) failures.push(`${dir}: missing name`);
  if (!pkg.license) failures.push(`${pkg.name}: missing license`);
  if (!pkg.exports?.["."])
    failures.push(`${pkg.name}: missing root export map`);
  if (!pkg.types) failures.push(`${pkg.name}: missing types field`);
  if (!pkg.files?.includes("dist"))
    failures.push(`${pkg.name}: package files must include dist`);
  if (pkg.private)
    failures.push(`${pkg.name}: publishable packages must not be private`);
  if (pkg.engines?.node !== ">=22.12.0")
    failures.push(`${pkg.name}: node engine mismatch`);
  for (const file of pkg.files ?? []) {
    try {
      await access(join(dir, file));
    } catch {
      failures.push(`${pkg.name}: files entry ${file} does not exist`);
    }
  }
  if (pkg.bin) {
    for (const [name, target] of Object.entries(pkg.bin)) {
      if (!String(target).startsWith("./dist/"))
        failures.push(`${pkg.name}: bin ${name} must point into dist`);
      if (pkg.exports?.["."]?.import === target) {
        failures.push(
          `${pkg.name}: bin ${name} must use a dedicated bin entrypoint, not the root export`,
        );
      }
      try {
        const bin = await readFile(join(dir, String(target)), "utf8");
        if (!bin.startsWith("#!/usr/bin/env node")) {
          failures.push(`${pkg.name}: bin ${name} is missing node shebang`);
        }
      } catch {
        failures.push(`${pkg.name}: bin ${name} target ${target} missing`);
      }
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
