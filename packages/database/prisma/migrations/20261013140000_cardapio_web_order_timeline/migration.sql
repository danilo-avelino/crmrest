-- Linha do tempo dos pedidos do Cardápio Web já gravados: o polling só guardava o status e os horários de saída e de
-- entrega. Daqui em diante cada etapa que o polling vê vira um evento do pedido, como no iFood.
INSERT INTO order_events (id, tenant_id, order_id, external_event_id, code, occurred_at)
SELECT gen_random_uuid(), o.tenant_id, o.id, e.code, e.code, e.at
FROM orders o
JOIN channels c ON c.id = o.channel_id AND c.type = 'CARDAPIO_WEB'
CROSS JOIN LATERAL (VALUES ('PLACED', o.placed_at), ('DISPATCHED', o.dispatched_at), ('DELIVERED', o.delivered_at)) AS e(code, at)
WHERE e.at IS NOT NULL
ON CONFLICT (order_id, external_event_id) DO NOTHING;
