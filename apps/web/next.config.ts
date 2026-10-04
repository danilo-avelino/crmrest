import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Imagem Docker: servidor enxuto com só os arquivos usados (o Dockerfile define NEXT_OUTPUT=standalone).
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // A API fica atrás de /api na mesma origem: o cookie de sessão funciona sem CORS.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${process.env.API_URL ?? "http://localhost:4000"}/api/:path*` }];
  },
};

export default nextConfig;
