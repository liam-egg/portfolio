Bun.serve({
  port: 80,
  hostname: "0.0.0.0",

  fetch(req) {
    return new Response(null, {
      status: 301,
      headers: {
        Location: "https://liameggleston.com"
      }
    });
  },

  error() {
    return new Response(null, { status: 404 });
  }
});
