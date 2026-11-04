const cov = JSON.parse(await Bun.file("/Users/brunopires/Developer/irori/apps/web/coverage/coverage-final.json").text());
const target = process.argv[2] ?? "models";
for (const [file, data] of Object.entries(cov)) {
  if (!file.includes(target)) continue;
  const missed = [];
  for (const [id, count] of Object.entries(data.s)) {
    if (count === 0) {
      const loc = data.statementMap[id];
      missed.push(loc.start.line === loc.end.line ? `${loc.start.line}` : `${loc.start.line}-${loc.end.line}`);
    }
  }
  console.log(file.split("/").slice(-2).join("/"), "MISSED:", missed.join(","));
}
