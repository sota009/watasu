export async function onRequestPost(context) {
  let payload;

  try {
    payload = await context.request.json();
  } catch {
    return Response.json(
      {
        ok: false,
        error: "Request body must be valid JSON."
      },
      { status: 400 }
    );
  }

  return Response.json({
    ok: true,
    received_at: new Date().toISOString(),
    received: payload
  });
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      allow: "POST, OPTIONS"
    }
  });
}

