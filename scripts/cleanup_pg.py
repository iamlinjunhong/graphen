#!/usr/bin/env python3
"""
cleanup_pg.py — 清理 PostgreSQL 中的旧数据和脏数据

清理内容:
  1. 硬删除已软删除超过 N 天的 memory_entries（级联清理 facts/evidence 等）
  2. 硬删除已软删除超过 N 天且 Neo4j 已同步的 memory_facts
  3. 清理已完成/失效的 entry_rewrite_jobs
  4. 清理旧的 memory_access_logs
  5. 清理旧的 memory_status_history
  6. 清理旧的 memory_operational_metrics
  7. 清理旧的 memory_fact_compat_metrics
  8. 清理孤儿 memory_evidence（fact 已不存在）
  9. 标记 neo4j 重试超限的已删除 facts 为 synced
 10. VACUUM ANALYZE 受影响的表

用法:
  python3 scripts/cleanup_pg.py [--retention-days=30] [--dry-run] [--verbose]

环境变量 (或在 .env 中配置):
  PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD
"""

import argparse
import os
import sys
from pathlib import Path

try:
    import psycopg2
    import psycopg2.extensions
except ImportError:
    print("❌ 需要安装 psycopg2: pip install psycopg2-binary")
    sys.exit(1)

# ─── 读取 .env ──────────────────────────────────────────────────────────────

def load_dotenv(path: str):
    """简易 .env 解析，不依赖 python-dotenv"""
    env_file = Path(path)
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


# ─── 配置 ───────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
load_dotenv(str(PROJECT_ROOT / ".env"))


def get_pg_config() -> dict:
    return {
        "host": os.environ.get("PG_HOST", "localhost"),
        "port": int(os.environ.get("PG_PORT", "5432")),
        "dbname": os.environ.get("PG_DATABASE", "graphen"),
        "user": os.environ.get("PG_USER", "graphen"),
        "password": os.environ.get("PG_PASSWORD", ""),
    }


# ─── 清理任务定义 ─────────────────────────────────────────────────────────

def build_tasks(retention_days: int) -> list[dict]:
    """构建所有清理任务"""
    # 日志/metrics 类保留更久 (3x)
    log_retention = retention_days * 3

    return [
        {
            "name": "硬删除已软删除的 memory_entries",
            "note": "级联删除关联的 facts, evidence, access_logs, status_history",
            "count_sql": f"""
                SELECT COUNT(*)::int AS cnt
                FROM memory_entries
                WHERE deleted_at IS NOT NULL
                  AND deleted_at < NOW() - INTERVAL '{retention_days} days'
            """,
            "exec_sql": f"""
                DELETE FROM memory_entries
                WHERE deleted_at IS NOT NULL
                  AND deleted_at < NOW() - INTERVAL '{retention_days} days'
            """,
        },
        {
            "name": "硬删除已软删除且 Neo4j 已同步的 memory_facts",
            "note": "仅清理 neo4j_synced=TRUE 的（已完成 Neo4j 端清理的 facts）",
            "count_sql": f"""
                SELECT COUNT(*)::int AS cnt
                FROM memory_facts
                WHERE deleted_at IS NOT NULL
                  AND deleted_at < NOW() - INTERVAL '{retention_days} days'
                  AND neo4j_synced = TRUE
            """,
            "exec_sql": f"""
                DELETE FROM memory_facts
                WHERE deleted_at IS NOT NULL
                  AND deleted_at < NOW() - INTERVAL '{retention_days} days'
                  AND neo4j_synced = TRUE
            """,
        },
        {
            "name": "清理已完成/失效的 entry_rewrite_jobs",
            "count_sql": f"""
                SELECT COUNT(*)::int AS cnt
                FROM entry_rewrite_jobs
                WHERE status IN ('succeeded', 'dead')
                  AND updated_at < NOW() - INTERVAL '{retention_days} days'
            """,
            "exec_sql": f"""
                DELETE FROM entry_rewrite_jobs
                WHERE status IN ('succeeded', 'dead')
                  AND updated_at < NOW() - INTERVAL '{retention_days} days'
            """,
        },
        {
            "name": f"清理旧的 memory_access_logs（>{log_retention}d）",
            "count_sql": f"""
                SELECT COUNT(*)::int AS cnt
                FROM memory_access_logs
                WHERE accessed_at < NOW() - INTERVAL '{log_retention} days'
            """,
            "exec_sql": f"""
                DELETE FROM memory_access_logs
                WHERE accessed_at < NOW() - INTERVAL '{log_retention} days'
            """,
        },
        {
            "name": f"清理旧的 memory_status_history（>{log_retention}d）",
            "count_sql": f"""
                SELECT COUNT(*)::int AS cnt
                FROM memory_status_history
                WHERE changed_at < NOW() - INTERVAL '{log_retention} days'
            """,
            "exec_sql": f"""
                DELETE FROM memory_status_history
                WHERE changed_at < NOW() - INTERVAL '{log_retention} days'
            """,
        },
        {
            "name": f"清理旧的 memory_operational_metrics（>{log_retention}d）",
            "count_sql": f"""
                SELECT COUNT(*)::int AS cnt
                FROM memory_operational_metrics
                WHERE metric_date < CURRENT_DATE - INTERVAL '{log_retention} days'
            """,
            "exec_sql": f"""
                DELETE FROM memory_operational_metrics
                WHERE metric_date < CURRENT_DATE - INTERVAL '{log_retention} days'
            """,
        },
        {
            "name": f"清理旧的 memory_fact_compat_metrics（>{log_retention}d）",
            "count_sql": f"""
                SELECT COUNT(*)::int AS cnt
                FROM memory_fact_compat_metrics
                WHERE metric_date < CURRENT_DATE - INTERVAL '{log_retention} days'
            """,
            "exec_sql": f"""
                DELETE FROM memory_fact_compat_metrics
                WHERE metric_date < CURRENT_DATE - INTERVAL '{log_retention} days'
            """,
        },
        {
            "name": "清理孤儿 memory_evidence（fact 已不存在）",
            "count_sql": """
                SELECT COUNT(*)::int AS cnt
                FROM memory_evidence ev
                WHERE NOT EXISTS (
                    SELECT 1 FROM memory_facts f WHERE f.id = ev.fact_id
                )
            """,
            "exec_sql": """
                DELETE FROM memory_evidence ev
                WHERE NOT EXISTS (
                    SELECT 1 FROM memory_facts f WHERE f.id = ev.fact_id
                )
            """,
        },
        {
            "name": "标记 neo4j 重试超限的已删除 facts 为 synced",
            "note": "已达最大重试次数的 deleted facts，标记为已同步以停止 Worker 重试",
            "count_sql": """
                SELECT COUNT(*)::int AS cnt
                FROM memory_facts
                WHERE fact_state = 'deleted'
                  AND neo4j_synced = FALSE
                  AND neo4j_retry_count >= 3
            """,
            "exec_sql": """
                UPDATE memory_facts
                SET neo4j_synced = TRUE,
                    neo4j_synced_at = NOW(),
                    neo4j_last_error = COALESCE(neo4j_last_error, '')
                        || ' [cleanup: marked synced after max retries]',
                    updated_at = NOW()
                WHERE fact_state = 'deleted'
                  AND neo4j_synced = FALSE
                  AND neo4j_retry_count >= 3
            """,
        },
    ]


# ─── 执行逻辑 ─────────────────────────────────────────────────────────────

def run_task(cur, task: dict, dry_run: bool, verbose: bool) -> int:
    """执行单个清理任务，返回影响行数"""
    name = task["name"]
    note = task.get("note")

    print(f"  ── {name} ──")
    if note and verbose:
        print(f"     ↳ {note}")

    try:
        cur.execute(task["count_sql"])
        row = cur.fetchone()
        count = row[0] if row else 0
    except psycopg2.errors.UndefinedTable:
        # 表不存在，跳过
        if verbose:
            print("     ↳ 表不存在，跳过")
        # 需要回滚当前事务才能继续
        cur.execute("ROLLBACK")
        cur.execute("BEGIN")
        return 0

    if verbose:
        print(f"     ↳ 找到 {count} 条待清理")

    if count == 0:
        if verbose:
            print("     ↳ 无需清理 ✓")
        return 0

    if dry_run:
        print(f"     ↳ [DRY-RUN] 将影响 {count} 行（跳过执行）")
        return count

    cur.execute(task["exec_sql"])
    affected = cur.rowcount or 0
    if verbose:
        print(f"     ↳ 已清理 {affected} 行 ✓")
    return affected


def vacuum_tables(conn, verbose: bool):
    """对受影响的表执行 VACUUM ANALYZE（需要 autocommit）"""
    print("\n  执行 VACUUM ANALYZE ...")
    old_isolation = conn.isolation_level
    conn.set_isolation_level(psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT)

    tables = [
        "memory_entries",
        "memory_facts",
        "memory_evidence",
        "memory_access_logs",
        "memory_status_history",
        "memory_operational_metrics",
        "memory_fact_compat_metrics",
        "entry_rewrite_jobs",
    ]
    cur = conn.cursor()
    for table in tables:
        try:
            cur.execute(f"VACUUM ANALYZE {table}")
            if verbose:
                print(f"     ↳ VACUUM ANALYZE {table} ✓")
        except Exception:
            if verbose:
                print(f"     ↳ VACUUM ANALYZE {table} 跳过（表可能不存在）")

    cur.close()
    conn.set_isolation_level(old_isolation)


# ─── 全量清空 ─────────────────────────────────────────────────────────────

PURGE_TABLES = [
    "entry_rewrite_jobs",
    "memory_fact_compat_metrics",
    "memory_operational_metrics",
    "memory_access_logs",
    "memory_status_history",
    "memory_evidence",
    "memory_facts",
    "memory_entries",
    "memory_categories",
    "chat_messages",
    "chat_sessions",
    "document_chunks",
    "documents",
]


def run_purge_all(pg_cfg: dict):
    """清空所有 memory/document 表数据"""
    print("╔══════════════════════════════════════════════════════╗")
    print("║  ⚠️  危险操作: 清空所有 memory/document 表数据 ⚠️    ║")
    print("╚══════════════════════════════════════════════════════╝")
    print(f"  连接: {pg_cfg['user']}@{pg_cfg['host']}:{pg_cfg['port']}/{pg_cfg['dbname']}")
    print()
    print("  将清空以下表:")
    for t in PURGE_TABLES:
        print(f"    • {t}")
    print()
    confirm = input("  输入 'yes' 确认清空所有数据: ").strip()
    if confirm != "yes":
        print("  已取消。")
        return

    conn = None
    try:
        conn = psycopg2.connect(**pg_cfg)
        cur = conn.cursor()

        for table in PURGE_TABLES:
            try:
                cur.execute(f"TRUNCATE TABLE {table} CASCADE")
                print(f"    🗑️  TRUNCATE {table} ✓")
            except Exception:
                conn.rollback()
                print(f"    ⏭️  {table} 不存在，跳过")
                cur = conn.cursor()
                continue

        conn.commit()

        # VACUUM
        conn.set_isolation_level(psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT)
        cur = conn.cursor()
        for table in PURGE_TABLES:
            try:
                cur.execute(f"VACUUM ANALYZE {table}")
            except Exception:
                pass
        cur.close()

        print("\n  ✅ 所有表已清空")
    except psycopg2.OperationalError as e:
        print(f"\n  ❌ 数据库连接失败: {e}")
        sys.exit(1)
    finally:
        if conn:
            conn.close()


def main():
    parser = argparse.ArgumentParser(description="清理 PostgreSQL 旧数据和脏数据")
    parser.add_argument("--retention-days", type=int, default=30,
                        help="保留天数，超过此天数的软删除数据将被硬删除 (默认: 30)")
    parser.add_argument("--dry-run", action="store_true",
                        help="仅统计不执行，预览将删除的数据量")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="显示详细输出")
    parser.add_argument("--purge-all", action="store_true",
                        help="⚠️ 危险: 清空所有 memory/document 表数据")
    args = parser.parse_args()

    dry_run = args.dry_run
    verbose = args.verbose or dry_run
    retention_days = args.retention_days
    purge_all = args.purge_all

    pg_cfg = get_pg_config()

    # ── --purge-all: 清空所有表 ─────────────────────────────────────
    if purge_all:
        run_purge_all(pg_cfg)
        return
    mode = "DRY-RUN（仅统计，不删除）" if dry_run else "LIVE（执行删除）"

    print("╔══════════════════════════════════════════════════════╗")
    print("║         PostgreSQL 数据清理脚本                      ║")
    print("╚══════════════════════════════════════════════════════╝")
    print(f"  连接:      {pg_cfg['user']}@{pg_cfg['host']}:{pg_cfg['port']}/{pg_cfg['dbname']}")
    print(f"  保留天数:  {retention_days}d（日志/metrics: {retention_days * 3}d）")
    print(f"  模式:      {mode}")
    print()

    conn = None
    try:
        conn = psycopg2.connect(**pg_cfg)
        cur = conn.cursor()

        # 验证连接
        cur.execute("SELECT NOW()")
        server_time = cur.fetchone()[0]
        print(f"  数据库连接成功，服务器时间: {server_time}\n")

        tasks = build_tasks(retention_days)
        results: list[tuple[str, int]] = []

        for task in tasks:
            affected = run_task(cur, task, dry_run, verbose)
            results.append((task["name"], affected))

        if not dry_run:
            conn.commit()

            # VACUUM（在 commit 后做，需要 autocommit）
            vacuum_tables(conn, verbose)
        else:
            conn.rollback()

        # ── 汇总 ───────────────────────────────────────────────────────
        print()
        print("  ═══════════════════════════════════════════════════════")
        print("  清理汇总:")
        print()
        total = 0
        for name, count in results:
            icon = "🗑️ " if count > 0 else "✅"
            print(f"    {icon} {name}: {count} 行")
            total += count
        print()
        print(f"  总计影响: {total} 行")
        print("  ═══════════════════════════════════════════════════════")

    except psycopg2.OperationalError as e:
        print(f"\n❌ 数据库连接失败: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ 清理脚本执行失败: {e}")
        if conn:
            conn.rollback()
        sys.exit(1)
    finally:
        if conn:
            conn.close()


if __name__ == "__main__":
    main()
