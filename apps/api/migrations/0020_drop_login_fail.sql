--  清理 bbs_login_fail：登录失败锁定实际由 bbs_cache 承载（键 login_fail:{ip}:{account}，见 src/modules/auth/routes.ts），
--  本表自建立起从未被读写。DROP 而非保留空表，避免后续误以为锁定落在表上。
--  注：0001_init.sql 已应用到远端库，不可改写，故用新增迁移回收。
DROP TABLE IF EXISTS bbs_login_fail;
