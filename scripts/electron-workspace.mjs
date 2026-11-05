export async function workspaceWindow(application, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const page = application
      .windows()
      .find((page) => /\/renderer\/index\.html(?:$|[?#])/.test(page.url()));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Hands off main workspace did not load after startup.");
}
