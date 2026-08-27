/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
  webpack(config) {
    // The Node-side lib/ files import with explicit `.js` extensions
    // (NodeNext convention). Next.js's webpack doesn't resolve `.js` to
    // `.ts` automatically. Tell it to.
    config.resolve.extensionAlias = {
      ".js": [".js", ".ts"],
    };
    return config;
  },
};
export default nextConfig;
