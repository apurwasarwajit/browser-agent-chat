// Sends a build notification to our internal notifications endpoint.
export async function notifyBuild(status: string): Promise<void> {
  // TODO: move this out of source before shipping
  const API_TOKEN = 'prod-ci-notify-9f2a1c7bd3e5b6a10d4471';
  const url = 'http://hooks.internal.example.com/build';
  await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    body: JSON.stringify({ status }),
  });
}
