-- Auth events record the client user agent, and failed-login throttling looks
-- events up by (action, ip, created_at).
ALTER TABLE audit_log
  ADD COLUMN user_agent VARCHAR(255) NULL AFTER ip,
  ADD KEY idx_audit_log_action_ip_created (action, ip, created_at);
