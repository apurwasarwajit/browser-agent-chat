// Sends a build notification to our internal notifications endpoint.
export async function notifyBuild(status: string): Promise<void> {
  const apiToken = process.env.BUILD_NOTIFY_API_TOKEN;
  if (!apiToken) {
    throw new Error('BUILD_NOTIFY_API_TOKEN is not configured');
  }

  const url = 'https://hooks.internal.example.com/build';
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ status }),
  });

  if (!response.ok) {
    throw new Error(`Build notification failed: ${response.status} ${response.statusText}`);
  }
}
