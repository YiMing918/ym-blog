#!/usr/bin/env python3
# watchdog.py — 看门狗：每天巡检线上站点，异常开/更新 GitHub Issue 留痕；全好静默。
# 跑在 GitHub Actions 里（见 .github/workflows/watchdog.yml），只用 Python 标准库，不依赖第三方包。
# 要查的东西（都走公开面，不带任何站内数据）：
#   1. 首页能打开（200）且含站名或文章标记；
#   2. RSS（rss.xml）可达（站点关了 RSS 时返回 404，属正常，会自动跳过）；
#   3. 任务健康端点 /api/tasks/health（需 TASK_SECRET）：备份是否超过 14 天没跑、待审是否积压。
# 站点地址：优先环境变量 SITE_URL（如 https://blog.example.com），缺省按仓库名猜 https://<仓库名>.pages.dev。
# 机械自愈：健康端点异常时先等 60 秒重查一次（多为临时抖动），复查仍异常才开 Issue，不重复刷屏。

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

SITE_URL = (os.environ.get("SITE_URL") or "").rstrip("/")
if not SITE_URL:
    repo = os.environ.get("GITHUB_REPOSITORY", "").split("/")[-1] or "ym-blog"
    SITE_URL = f"https://{repo}.pages.dev"

TASK_SECRET = os.environ.get("TASK_SECRET", "")
ISSUE_LABEL = "watchdog"


def fetch(url, headers=None, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "ym-blog-watchdog/1.0", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception:
            return e.code, ""
    except Exception as e:
        return 0, f"ERR: {e}"


def check_site():
    problems = []
    status, body = fetch(SITE_URL + "/")
    if status != 200:
        problems.append(f"首页状态码异常：{status}（期望 200）")
    elif "<html" not in body.lower():
        problems.append("首页打开了但不像 HTML 页面（可能部署坏了）")
    status, _ = fetch(SITE_URL + "/rss.xml")
    if status not in (200, 404):
        problems.append(f"RSS 状态码异常：{status}（200=正常，404=站点已关闭 RSS 也正常）")
    return problems


def check_health():
    if not TASK_SECRET:
        return [], "未配置 TASK_SECRET，跳过任务健康检查（只能查公开面）"
    status, body = fetch(SITE_URL + "/api/tasks/health", headers={"X-Task-Secret": TASK_SECRET})
    if status != 200:
        return [f"任务健康端点异常：{status}（检查 TASK_SECRET 是否与站点一致）"], ""
    try:
        data = json.loads(body).get("data") or {}
    except Exception:
        return ["任务健康端点返回的不是 JSON"], ""
    problems = []
    if data.get("backup_stale"):
        problems.append("自动备份已超过 14 天没成功（或从没跑过），去后台「备份」页看一眼")
    if (data.get("pending_comments") or 0) >= 20:
        problems.append(f"待审评论积压 {data['pending_comments']} 条，记得去后台审一下")
    return problems, ""


def open_or_update_issue(problems):
    body = "看门狗发现问题（站点：" + SITE_URL + "）：\n\n" + "\n".join(f"- {p}" for p in problems) \
        + "\n\n先看 MAINTENANCE.md 的故障对照表；处理完把本 Issue 关掉即可，下次再出问题会重新开。"

    def gh(*args):
        # gh 关键调用逐步检查返回值：任一步失败都把错误打进日志并以非零码退出，
        # 让工作流如实标红——绝不静默吞掉（否则报警通道本身坏了也没人知道）。
        r = subprocess.run(["gh", *args], capture_output=True, text=True)
        if r.returncode != 0:
            print(f"看门狗开单失败：gh {' '.join(args[:3])} 出错：" + ((r.stderr or r.stdout) or "").strip()[:300],
                  file=sys.stderr)
            sys.exit(1)
        return r

    # 先确保标签存在（照 ym-pan 版看门狗 report_issue 的做法）：仓库没有 watchdog
    # 标签时，带 --label 的 issue list/create 会被 gh 拒绝，报警根本发不出去。
    gh("label", "create", ISSUE_LABEL, "--force")
    existing = gh("issue", "list", "--label", ISSUE_LABEL, "--state", "open", "--json", "number")
    try:
        open_nums = [i["number"] for i in json.loads(existing.stdout or "[]")]
    except Exception:
        print("看门狗开单失败：gh issue list 返回无法解析：" + (existing.stdout or "")[:200], file=sys.stderr)
        sys.exit(1)
    if open_nums:
        gh("issue", "comment", str(open_nums[0]), "--body", body)
        print(f"看门狗：已在已有 Issue #{open_nums[0]} 追加本轮报告。")
        return
    gh("issue", "create", "--title", "🐕 看门狗：站点需要看一眼",
       "--label", ISSUE_LABEL, "--body", body)
    print("看门狗：已新建 Issue 报告本轮问题。")


def heartbeat():
    """心跳保活：GitHub 会停用 60 天无活动的公开仓库的定时任务。
    若距上次提交超过 25 天且本轮没有别的提交，留一个时间戳提交保持活跃。
    git 操作逐步检查返回值（照 ym-cfip 工作流的心跳写法）：先配身份 → 显式 add →
    提交前先查暂存区有无变更 → commit/push 任一步失败都以非零码退出让工作流如实标红；
    无变更时正常跳过、不算失败。"""
    def git(*args):
        return subprocess.run(["git", *args], capture_output=True, text=True)

    def fail(step, r):
        print(f"心跳保活失败：git {step} 出错：" + ((r.stderr or r.stdout) or "").strip()[:200],
              file=sys.stderr)
        sys.exit(1)

    r = git("log", "-1", "--format=%ct")
    if r.returncode != 0:
        fail("log", r)
    try:
        last = int(r.stdout.strip())
    except Exception:
        print("心跳保活失败：git log 输出无法解析：" + r.stdout.strip()[:100], file=sys.stderr)
        sys.exit(1)
    if time.time() - last <= 25 * 86400:
        return
    with open(".heartbeat", "a", encoding="utf-8") as f:
        f.write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + "\n")
    for args in (("config", "user.name", "github-actions[bot]"),
                 ("config", "user.email", "github-actions[bot]@users.noreply.github.com"),
                 ("add", ".heartbeat")):
        r = git(*args)
        if r.returncode != 0:
            fail(" ".join(args), r)
    if git("diff", "--cached", "--quiet").returncode == 0:
        print("心跳保活：.heartbeat 无变更，跳过提交。")
        return
    r = git("commit", "-m", "watchdog: 心跳保活")
    if r.returncode != 0:
        fail("commit", r)
    r = git("push")
    if r.returncode != 0:
        fail("push", r)
    print("心跳保活：已提交并推送时间戳提交。")


def main():
    problems = check_site()
    hp, note = check_health()
    problems += hp
    if note:
        print(note)
    if problems:
        # 抖动复查：等 60 秒再查一遍，两轮都异常才报
        time.sleep(60)
        again = check_site()
        hp2, _ = check_health()
        again += hp2
        if again:
            print("看门狗发现问题：")
            for p in again:
                print(" -", p)
            open_or_update_issue(again)
        else:
            print("首轮异常、复查已恢复，按临时抖动处理，不报。")
    else:
        print("看门狗：一切正常。")
    heartbeat()


if __name__ == "__main__":
    main()
