
export default async function handler(req, res) {
  const host = String(req.headers.host || "");
  const forwardedProtocol = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const isLoopback = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(host);
  const protocol = forwardedProtocol === "https" || !isLoopback
    ? "https:"
    : "http:";
  const allowedOrigin = `${protocol}//${host}`;

  if (
    req.headers.origin &&
    req.headers.origin !== allowedOrigin
  ) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  if (req.headers.origin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  }
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

    const successful = upstream.ok;
    const diagnosticStatus = successful ? 200 : upstream.status;

    return res.status(diagnosticStatus).json({
      diagnostic: successful
        ? "Upstream root responded successfully"
        : "Upstream root returned an error",
      upstreamStatus: upstream.status
    });
  } catch (error) {
    return res.status(502).json({
      diagnostic: "Upstream connection failed",
      message: String(error)
    });
  }
}
