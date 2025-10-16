export default async function teardown() {
  // Give containers time to stop gracefully
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Force exit to prevent hanging
  process.exit(0);
}
