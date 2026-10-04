-- Roles da aplicação para desenvolvimento local (roda só na primeira inicialização do volume).
-- app_user: sem login; recebe os GRANTs nas migrations e está sujeita à RLS.
-- comanda_app: login usado pela aplicação (DATABASE_URL). Em produção, a infra cria o login equivalente.
CREATE ROLE app_user NOLOGIN;
CREATE ROLE comanda_app LOGIN PASSWORD 'comanda_app' IN ROLE app_user;
