/** @type {import('next').NextConfig} */
const nextConfig = {
  // The postgres driver is server-only; keep it out of client bundles.
  serverExternalPackages: ['postgres'],
};

export default nextConfig;
