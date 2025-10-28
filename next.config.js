/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      { source: "/stage2", destination: "/stage2/index.html" },
      { source: "/stage2/", destination: "/stage2/index.html" },
      { source: "/stage2/review", destination: "/stage2/review/index.html" },
      { source: "/stage2/review/", destination: "/stage2/review/index.html" },
      { source: "/meta-v2", destination: "/meta-v2/index.html" },
      { source: "/meta-v2/", destination: "/meta-v2/index.html" },
    ];
  },
};

module.exports = nextConfig;
