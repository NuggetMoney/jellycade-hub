
export default async function handler(req, res) {
  const allowedOrigin = "https://jellycade-hub.vercel.app";

  if (
    req.headers.origin &&
    req.headers.origin !== allowedOrigin
  ) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Use GET for this diagnostic"
    });
  }

  try {
    const upstream = await fetch(
      "https://dev-nakama.winterpixel.io/"
    );

    return res.status(200).json({
      diagnostic: "Upstream reached",
      upstreamStatus: upstream.status
    });
  } catch (error) {
    return res.status(502).json({
      diagnostic: "Upstream connection failed",
      message: String(error)
    });
  }
}
