#!/usr/bin/env python3
"""
cleanup_neo4j.py — 清理 Neo4j 中的旧数据和脏数据

清理内容:
  1. 删除孤儿 Entity 节点（没有任何边的 auto 类型节点）
  2. 删除已在 PG 中标记删除但 Neo4j 未清理的边（通过 syncKey 对比 PG facts）
  3. 删除 sourceDocumentIds 为空列表的边（无来源文档的脏边）
  4. 删除 relationType 为空的边（缺少关系类型的脏边）
  5. 删除 name 为空的 Entity 节点
  6. 统计清理后的节点/边数量

用法:
  python3 scripts/cleanup_neo4j.py [--dry-run] [--verbose] [--with-pg-cross-check]

环境变量 (或在 .env 中配置):
  NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, NEO4J_DATABASE
  PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD (仅 --with-pg-cross-check 时需要)
"""

import argparse
import os
import sys
from pathlib import Path

try:
    from neo4j import GraphDatabase
except ImportError:
    print("❌ 需要安装 neo4j driver: pip install neo4j")
    sys.exit(1)

# ─── 读取 .env ──────────────────────────────────────────────────────────────

def load_dotenv(path: str):
    """简易 .env 解析"""
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


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
load_dotenv(str(PROJECT_ROOT / ".env"))


def get_neo4j_config() -> dict:
    return {
        "uri": os.environ.get("NEO4J_URI", "bolt://localhost:7687"),
        "user": os.environ.get("NEO4J_USER", "neo4j"),
        "password": os.environ.get("NEO4J_PASSWORD", ""),
        "database": os.environ.get("NEO4J_DATABASE", "neo4j"),
    }


def get_pg_config() -> dict:
    return {
        "host": os.environ.get("PG_HOST", "localhost"),
        "port": int(os.environ.get("PG_PORT", "5432")),
        "dbname": os.environ.get("PG_DATABASE", "graphen"),
        "user": os.environ.get("PG_USER", "graphen"),
        "password": os.environ.get("PG_PASSWORD", ""),
    }


# ─── Neo4j 清理任务 ──────────────────────────────────────────────────────

def count_graph_stats(session) -> dict:
    """统计当前图谱节点/边数量"""
    node_result = session.run("MATCH (n) RETURN count(n) AS cnt")
    node_count = node_result.single()["cnt"]

    edge_result = session.run("MATCH ()-[r]->() RETURN count(r) AS cnt")
    edge_count = edge_result.single()["cnt"]

    entity_result = session.run("MATCH (n:Entity) RETURN count(n) AS cnt")
    entity_count = entity_result.single()["cnt"]

    auto_result = session.run("MATCH (n:Entity {type: 'auto'}) RETURN count(n) AS cnt")
    auto_count = auto_result.single()["cnt"]

    return {
        "total_nodes": node_count,
        "total_edges": edge_count,
        "entity_nodes": entity_count,
        "auto_entity_nodes": auto_count,
    }


def cleanup_orphan_auto_nodes(session, dry_run: bool, verbose: bool) -> int:
    """删除没有任何边的 auto 类型 Entity 节点"""
    name = "孤儿 auto Entity 节点（无边）"
    print(f"  ── {name} ──")

    count_result = session.run("""
        MATCH (n:Entity {type: 'auto'})
        WHERE NOT EXISTS { (n)-[]-() }
        RETURN count(n) AS cnt
    """)
    count = count_result.single()["cnt"]

    if verbose:
        print(f"     ↳ 找到 {count} 个孤儿节点")

    if count == 0:
        if verbose:
            print("     ↳ 无需清理 ✓")
        return 0

    if dry_run:
        print(f"     ↳ [DRY-RUN] 将删除 {count} 个节点（跳过执行）")
        return count

    result = session.run("""
        MATCH (n:Entity {type: 'auto'})
        WHERE NOT EXISTS { (n)-[]-() }
        DETACH DELETE n
        RETURN count(n) AS deleted
    """)
    deleted = result.single()["deleted"]
    if verbose:
        print(f"     ↳ 已删除 {deleted} 个节点 ✓")
    return deleted


def cleanup_empty_name_nodes(session, dry_run: bool, verbose: bool) -> int:
    """删除 name 为空的 Entity 节点"""
    name = "name 为空/null 的 Entity 节点"
    print(f"  ── {name} ──")

    count_result = session.run("""
        MATCH (n:Entity)
        WHERE n.name IS NULL OR trim(n.name) = ''
        RETURN count(n) AS cnt
    """)
    count = count_result.single()["cnt"]

    if verbose:
        print(f"     ↳ 找到 {count} 个空名节点")

    if count == 0:
        if verbose:
            print("     ↳ 无需清理 ✓")
        return 0

    if dry_run:
        print(f"     ↳ [DRY-RUN] 将删除 {count} 个节点（跳过执行）")
        return count

    result = session.run("""
        MATCH (n:Entity)
        WHERE n.name IS NULL OR trim(n.name) = ''
        DETACH DELETE n
        RETURN count(n) AS deleted
    """)
    deleted = result.single()["deleted"]
    if verbose:
        print(f"     ↳ 已删除 {deleted} 个节点 ✓")
    return deleted


def cleanup_empty_relation_edges(session, dry_run: bool, verbose: bool) -> int:
    """删除 relationType 为空的 RELATED_TO 边"""
    name = "relationType 为空的 RELATED_TO 边"
    print(f"  ── {name} ──")

    count_result = session.run("""
        MATCH ()-[r:RELATED_TO]-()
        WHERE r.relationType IS NULL OR trim(r.relationType) = ''
        RETURN count(r) AS cnt
    """)
    count = count_result.single()["cnt"]

    if verbose:
        print(f"     ↳ 找到 {count} 条脏边")

    if count == 0:
        if verbose:
            print("     ↳ 无需清理 ✓")
        return 0

    if dry_run:
        print(f"     ↳ [DRY-RUN] 将删除 {count} 条边（跳过执行）")
        return count

    result = session.run("""
        MATCH ()-[r:RELATED_TO]-()
        WHERE r.relationType IS NULL OR trim(r.relationType) = ''
        DELETE r
        RETURN count(r) AS deleted
    """)
    deleted = result.single()["deleted"]
    if verbose:
        print(f"     ↳ 已删除 {deleted} 条边 ✓")
    return deleted


def cleanup_no_synckey_edges(session, dry_run: bool, verbose: bool) -> int:
    """删除没有 syncKey 的 RELATED_TO 边（脏数据，无法追溯来源）"""
    name = "无 syncKey 的 RELATED_TO 边"
    print(f"  ── {name} ──")

    count_result = session.run("""
        MATCH ()-[r:RELATED_TO]-()
        WHERE r.syncKey IS NULL OR trim(r.syncKey) = ''
        RETURN count(r) AS cnt
    """)
    count = count_result.single()["cnt"]

    if verbose:
        print(f"     ↳ 找到 {count} 条无 syncKey 的边")

    if count == 0:
        if verbose:
            print("     ↳ 无需清理 ✓")
        return 0

    if dry_run:
        print(f"     ↳ [DRY-RUN] 将删除 {count} 条边（跳过执行）")
        return count

    result = session.run("""
        MATCH ()-[r:RELATED_TO]-()
        WHERE r.syncKey IS NULL OR trim(r.syncKey) = ''
        DELETE r
        RETURN count(r) AS deleted
    """)
    deleted = result.single()["deleted"]
    if verbose:
        print(f"     ↳ 已删除 {deleted} 条边 ✓")
    return deleted


def cleanup_duplicate_edges(session, dry_run: bool, verbose: bool) -> int:
    """清理重复的 RELATED_TO 边（相同 syncKey 出现多次，保留最新）"""
    name = "重复 syncKey 的 RELATED_TO 边（保留最新）"
    print(f"  ── {name} ──")

    count_result = session.run("""
        MATCH ()-[r:RELATED_TO]-()
        WHERE r.syncKey IS NOT NULL
        WITH r.syncKey AS sk, collect(r) AS rels
        WHERE size(rels) > 1
        RETURN sum(size(rels) - 1) AS cnt
    """)
    count = count_result.single()["cnt"] or 0

    if verbose:
        print(f"     ↳ 找到 {count} 条重复边")

    if count == 0:
        if verbose:
            print("     ↳ 无需清理 ✓")
        return 0

    if dry_run:
        print(f"     ↳ [DRY-RUN] 将删除 {count} 条重复边（跳过执行）")
        return count

    result = session.run("""
        MATCH ()-[r:RELATED_TO]-()
        WHERE r.syncKey IS NOT NULL
        WITH r.syncKey AS sk, collect(r) AS rels
        WHERE size(rels) > 1
        UNWIND rels[1..] AS dup
        DELETE dup
        RETURN count(dup) AS deleted
    """)
    deleted = result.single()["deleted"]
    if verbose:
        print(f"     ↳ 已删除 {deleted} 条重复边 ✓")
    return deleted


def cross_check_pg_deleted_facts(session, dry_run: bool, verbose: bool) -> int:
    """
    交叉检查: 从 PG 中查找已删除的 facts 的 syncKey，
    在 Neo4j 中查找并删除这些残留的边。
    """
    name = "PG 已删除 facts 在 Neo4j 中的残留边（交叉检查）"
    print(f"  ── {name} ──")

    try:
        import psycopg2
    except ImportError:
        print("     ↳ 跳过: psycopg2 未安装")
        return 0

    pg_cfg = get_pg_config()
    try:
        pg_conn = psycopg2.connect(**pg_cfg)
    except Exception as e:
        print(f"     ↳ 跳过: PG 连接失败 ({e})")
        return 0

    try:
        pg_cur = pg_conn.cursor()

        # 查找已删除但 Neo4j 未同步的 facts 的 syncKey
        pg_cur.execute("""
            SELECT entry_id || ':' || normalized_fact_key AS sync_key
            FROM memory_facts
            WHERE fact_state = 'deleted'
              AND neo4j_synced = FALSE
        """)
        deleted_sync_keys = [row[0] for row in pg_cur.fetchall()]
        pg_cur.close()
    finally:
        pg_conn.close()

    if verbose:
        print(f"     ↳ PG 中有 {len(deleted_sync_keys)} 个已删除但 Neo4j 未同步的 facts")

    if not deleted_sync_keys:
        if verbose:
            print("     ↳ 无需清理 ✓")
        return 0

    # 分批处理（每批 100 个）
    total_deleted = 0
    batch_size = 100

    for i in range(0, len(deleted_sync_keys), batch_size):
        batch = deleted_sync_keys[i : i + batch_size]

        count_result = session.run("""
            UNWIND $syncKeys AS sk
            MATCH ()-[r:RELATED_TO {syncKey: sk}]-()
            RETURN count(r) AS cnt
        """, syncKeys=batch)
        batch_count = count_result.single()["cnt"]

        if batch_count == 0:
            continue

        if dry_run:
            total_deleted += batch_count
            continue

        # 删除边并清理孤儿节点
        result = session.run("""
            UNWIND $syncKeys AS sk
            MATCH (s)-[r:RELATED_TO {syncKey: sk}]->(o)
            DELETE r
            WITH s, o
            CALL {
                WITH s
                WITH s WHERE s.type = 'auto'
                    AND NOT EXISTS { (s)-[]-() }
                DETACH DELETE s
            }
            CALL {
                WITH o
                WITH o WHERE o.type = 'auto'
                    AND NOT EXISTS { (o)-[]-() }
                DETACH DELETE o
            }
            RETURN count(*) AS deleted
        """, syncKeys=batch)
        batch_deleted = result.single()["deleted"]
        total_deleted += batch_deleted

    if verbose:
        action = "[DRY-RUN] 将删除" if dry_run else "已删除"
        print(f"     ↳ {action} {total_deleted} 条残留边 ✓")

    # 成功后回来标记 PG 中对应的 facts 为已同步
    if not dry_run and total_deleted > 0:
        try:
            pg_conn = psycopg2.connect(**pg_cfg)
            pg_cur = pg_conn.cursor()
            pg_cur.execute("""
                UPDATE memory_facts
                SET neo4j_synced = TRUE,
                    neo4j_synced_at = NOW(),
                    neo4j_last_error = NULL,
                    updated_at = NOW()
                WHERE fact_state = 'deleted'
                  AND neo4j_synced = FALSE
            """)
            pg_conn.commit()
            if verbose:
                print(f"     ↳ 已将 PG 中 {pg_cur.rowcount} 个 facts 标记为 neo4j_synced=TRUE")
            pg_cur.close()
            pg_conn.close()
        except Exception as e:
            print(f"     ↳ ⚠️ 标记 PG facts 失败: {e}")

    return total_deleted


# ─── 全量清空 ─────────────────────────────────────────────────────────────

def run_purge_all_neo4j(neo4j_cfg: dict):
    """清空 Neo4j 中的所有节点和边"""
    print("╔══════════════════════════════════════════════════════╗")
    print("║  ⚠️  危险操作: 清空 Neo4j 所有节点和边 ⚠️            ║")
    print("╚══════════════════════════════════════════════════════╝")
    print(f"  连接:   {neo4j_cfg['uri']}")
    print(f"  数据库: {neo4j_cfg['database']}")
    print()

    driver = None
    try:
        auth = (neo4j_cfg["user"], neo4j_cfg["password"]) if neo4j_cfg["password"] else None
        driver = GraphDatabase.driver(neo4j_cfg["uri"], auth=auth)
        driver.verify_connectivity()

        with driver.session(database=neo4j_cfg["database"]) as session:
            stats = count_graph_stats(session)
            print(f"  当前: {stats['total_nodes']} 节点, {stats['total_edges']} 边")

        if stats["total_nodes"] == 0 and stats["total_edges"] == 0:
            print("  图谱已为空，无需清理。")
            return

        print()
        confirm = input("  输入 'yes' 确认清空所有图谱数据: ").strip()
        if confirm != "yes":
            print("  已取消。")
            return

        # 分批删除以避免内存溢出
        total_deleted = 0
        batch_size = 5000
        with driver.session(database=neo4j_cfg["database"]) as session:
            while True:
                result = session.run(f"""
                    MATCH (n)
                    WITH n LIMIT {batch_size}
                    DETACH DELETE n
                    RETURN count(n) AS deleted
                """)
                deleted = result.single()["deleted"]
                if deleted == 0:
                    break
                total_deleted += deleted
                print(f"    🗑️  已删除 {total_deleted} 个节点 ...")

            after = count_graph_stats(session)

        print(f"\n  ✅ 图谱已清空: {after['total_nodes']} 节点, {after['total_edges']} 边")
        print(f"  共删除 {total_deleted} 个节点")

    except Exception as e:
        print(f"\n  ❌ 清空失败: {e}")
        sys.exit(1)
    finally:
        if driver:
            driver.close()


def main():
    parser = argparse.ArgumentParser(description="清理 Neo4j 中的旧数据和脏数据")
    parser.add_argument("--dry-run", action="store_true",
                        help="仅统计不执行，预览将删除的数据量")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="显示详细输出")
    parser.add_argument("--with-pg-cross-check", action="store_true",
                        help="启用 PG 交叉检查: 查找 PG 已删除但 Neo4j 残留的边")
    parser.add_argument("--purge-all", action="store_true",
                        help="⚠️ 危险: 清空 Neo4j 中的所有节点和边")
    args = parser.parse_args()

    dry_run = args.dry_run
    verbose = args.verbose or dry_run
    cross_check = args.with_pg_cross_check

    neo4j_cfg = get_neo4j_config()

    # ── --purge-all: 清空整个图谱 ────────────────────────────────────
    if args.purge_all:
        run_purge_all_neo4j(neo4j_cfg)
        return

    mode = "DRY-RUN（仅统计，不删除）" if dry_run else "LIVE（执行删除）"

    print("╔══════════════════════════════════════════════════════╗")
    print("║            Neo4j 数据清理脚本                        ║")
    print("╚══════════════════════════════════════════════════════╝")
    print(f"  连接:      {neo4j_cfg['uri']}")
    print(f"  数据库:    {neo4j_cfg['database']}")
    print(f"  模式:      {mode}")
    print(f"  PG 交叉检查: {'启用' if cross_check else '禁用'}")
    print()

    driver = None
    try:
        auth = (neo4j_cfg["user"], neo4j_cfg["password"]) if neo4j_cfg["password"] else None
        driver = GraphDatabase.driver(neo4j_cfg["uri"], auth=auth)
        driver.verify_connectivity()
        print("  Neo4j 连接成功 ✓\n")

        results: list[tuple[str, int]] = []

        with driver.session(database=neo4j_cfg["database"]) as session:
            # 清理前统计
            before_stats = count_graph_stats(session)
            print(f"  清理前: {before_stats['total_nodes']} 节点, "
                  f"{before_stats['total_edges']} 边 "
                  f"({before_stats['entity_nodes']} Entity, "
                  f"{before_stats['auto_entity_nodes']} auto)")
            print()

            # 1. 清理脏边
            r = cleanup_empty_relation_edges(session, dry_run, verbose)
            results.append(("relationType 为空的边", r))

            r = cleanup_no_synckey_edges(session, dry_run, verbose)
            results.append(("无 syncKey 的边", r))

            r = cleanup_duplicate_edges(session, dry_run, verbose)
            results.append(("重复 syncKey 的边", r))

            # 2. PG 交叉检查（可选）
            if cross_check:
                r = cross_check_pg_deleted_facts(session, dry_run, verbose)
                results.append(("PG 已删除 facts 的 Neo4j 残留边", r))

            # 3. 清理脏节点
            r = cleanup_empty_name_nodes(session, dry_run, verbose)
            results.append(("name 为空的 Entity 节点", r))

            # 4. 最后清理孤儿节点（其他清理可能产生新的孤儿）
            r = cleanup_orphan_auto_nodes(session, dry_run, verbose)
            results.append(("孤儿 auto Entity 节点", r))

            # 清理后统计
            if not dry_run:
                after_stats = count_graph_stats(session)
            else:
                after_stats = before_stats

        # ── 汇总 ───────────────────────────────────────────────────────
        print()
        print("  ═══════════════════════════════════════════════════════")
        print("  清理汇总:")
        print()
        total = 0
        for task_name, count in results:
            icon = "🗑️ " if count > 0 else "✅"
            print(f"    {icon} {task_name}: {count}")
            total += count
        print()
        if not dry_run:
            node_diff = before_stats["total_nodes"] - after_stats["total_nodes"]
            edge_diff = before_stats["total_edges"] - after_stats["total_edges"]
            print(f"  清理后: {after_stats['total_nodes']} 节点 (-{node_diff}), "
                  f"{after_stats['total_edges']} 边 (-{edge_diff})")
        print(f"  总计影响: {total} 个对象")
        print("  ═══════════════════════════════════════════════════════")

    except Exception as e:
        print(f"\n❌ 清理脚本执行失败: {e}")
        sys.exit(1)
    finally:
        if driver:
            driver.close()


if __name__ == "__main__":
    main()
