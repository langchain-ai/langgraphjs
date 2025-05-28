export function $(strings, ...rest) {
  const command = strings.reduce((acc, item, idx) => {
    acc += item;
    const arg = rest[idx];
    if (Array.isArray(arg)) {
      acc += arg.join(" ");
    } else if (typeof arg === "string" || typeof arg === "number") {
      acc += arg;
    }
    return acc;
  }, "$ ");

  process.stderr.write(command + "\n");
  return Bun.$(strings, ...rest);
}
