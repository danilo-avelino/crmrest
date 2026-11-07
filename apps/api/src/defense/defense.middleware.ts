import type { RequestHandler } from "express";
import { isSensitiveProbe } from "./defense.rules.js";
import type { DefenseService } from "./defense.service.js";

/**
 * Antes de qualquer rota: recusa o IP banido (403), bane quem sonda arquivos sensíveis (responde 404, como se não
 * existissem) e conta os pedidos recusados, depois da resposta, sem atrasá-la.
 */
export function defenseMiddleware(defense: DefenseService): RequestHandler {
  return (req, res, next) => {
    const ip = defense.ipOf(req);
    if (!ip) return next();
    void defense.isBanned(ip).then((banned) => {
      if (banned) {
        res.status(403).json({ statusCode: 403, message: "Acesso bloqueado." });
        return;
      }
      if (isSensitiveProbe(req.path)) {
        void defense.ban(ip, req, "sensitive_probe");
        res.status(404).json({ statusCode: 404, message: "Not Found" });
        return;
      }
      res.on("finish", () => {
        if (res.statusCode >= 400) void defense.observe(ip, req, res.statusCode);
      });
      next();
    });
  };
}
