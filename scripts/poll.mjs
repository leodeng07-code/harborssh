// Playwright's predicate polling treats a Promise as truthy; poll async IPC checks in Node.
export async function poll(page, predicate, arg, { timeout = 30000 } = {}) {
  const started = Date.now();
  while (!await page.evaluate(predicate, arg)) {
    if (Date.now() - started >= timeout) throw new Error(`Timed out after ${timeout}ms waiting for desktop IPC state`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
