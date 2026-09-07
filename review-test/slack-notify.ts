// Sends a build notification to our internal notifications endpoint.
export async function notifyBuild(status: string): Promise<void> {
  const apiToken = process.env.SLACK_API_TOKEN;
  if (!apiToken) {
    throw new Error('SLACK_API_TOKEN is not configured');
  }

  const url = 'https://hooks.internal.example.com/build';
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ status }),
  });

  if (!response.ok) {
    throw new Error(
      `Build notification failed with HTTP ${response.status} ${response.statusText}`,
    );
  }
}
