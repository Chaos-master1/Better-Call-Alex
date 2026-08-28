/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native module; Next.js must not bundle it.
  // This was the experimental `serverComponentsExternalPackages` in
  // Next 14; Next 15 promotes it to a top-level option.
  serverExternalPackages: ["better-sqlite3"],
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
