import { $, type ExecaScriptMethod } from "execa";
import { homedir } from "node:os";
let PATH: string | undefined = undefined;

async function getUserShell() {
  return process.env.SHELL || "/bin/sh";
}

async function getProcessPath() {
  return process.env.PATH || "";
}

async function verifyDockerPath(PATH: string) {
  await $({ env: { PATH } })`which docker`;
  return PATH;
}

async function extractPathFromShell() {
  const pathToShell = await getUserShell();

  const args = pathToShell.includes("csh")
    ? ["-c", "echo $PATH"]
    : ["-lc", "echo $PATH"];
  const shell = await $(pathToShell, args);
  return shell.stdout.trim();
}

async function guessUserPath() {
  return [
    "/bin",
    "/usr/bin",
    "/usr/local/bin",
    "/sbin",
    "/usr/sbin",
    "/usr/local/sbin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    `${homedir()}/.local/bin`,
    "/Applications/Docker.app/Contents/Resources/bin",
    `${homedir()}/.docker/bin`,

    // support for Rancher Desktop
    // https://github.com/langchain-ai/langgraph-studio/issues/24#issuecomment-2274046328
    // https://github.com/langchain-ai/langgraph-studio/issues/122
    `${homedir()}/.rd/bin`,
    `/Applications/Rancher Desktop.app/Contents/Resources/resources/darwin/bin`,
  ].join(":");
}

async function getLoginPath() {
  if (PATH) return { PATH };

  const [fromProcess, fromShell, fromBackup] = await Promise.allSettled(
    [getProcessPath(), extractPathFromShell(), guessUserPath()].map((promise) =>
      promise.then(verifyDockerPath)
    )
  );

  if (fromProcess.status === "fulfilled") {
    PATH = fromProcess.value;
  } else if (fromShell.status === "fulfilled") {
    PATH = fromShell.value;
  } else if (fromBackup.status === "fulfilled") {
    PATH = fromBackup.value;
  } else {
    console.error(
      "Failed to get PATH from process, shell, or backup",
      fromProcess.reason,
      fromShell.reason,
      fromBackup.reason
    );
    throw fromProcess.reason || fromShell.reason || fromBackup.reason;
  }

  return { PATH };
}

type CommonOptions = Exclude<Parameters<ExecaScriptMethod>[1], undefined>;

export async function getExecaOptions<T extends CommonOptions = {}>(
  options?: T
) {
  const env = await getLoginPath();
  return { ...options, env } as T & { env: typeof env };
}
