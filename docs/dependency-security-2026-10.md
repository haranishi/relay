# 依存関係の脆弱性対応（2026年10月）

## 要件

- 10月30日時点のDependabot警告50件を、該当する依存経路の更新で解消する。
- 出品・応募・候補選定・辞退・繰上げ・完了とイベント契約を維持する。
- 既存のNode 24以上・pnpm 11.16.0・無料のローカル検証を使う。
- クラウドへの配置や認証・通知の新規実装は今回の対象に含めない。

## 設計

既存の[進捗メモ](進捗メモ.md)にある10月22日の依存更新を引き継ぐ。
開発サーバーはローカルのファイル・実行権限に触れるため、
本番に含まれない依存も更新対象にする。

- Vitestを全11パッケージで4.1.10から4.1.12へ更新し、mockerの脆弱性を解消する。
- WorkerのWranglerを4.113.0からWebと同じ4.151.1へ更新する。
  旧Miniflareに残るsharp 0.34.5とundici 7.28.0の経路を除く。
- 親依存の更新だけで残るglob・brace-expansion・js-yaml・proxy-addr・qs・Viteは、
  脆弱な範囲だけを選ぶpnpmのoverridesで同じmajor内の修正版へ固定する。
- 公開直後の版を避ける既存の最小経過日数とビルド許可の設定を維持する。
- アプリの仕様変更や一律の最新版更新は避け、lockfileを再生成する。

修正版の根拠は[Vitestの公開勧告](https://github.com/advisories/GHSA-qxg6-89mg-rqv8)、
[sharpの公開勧告](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)、
GitHub Dependabotの各警告およびnpmの公開パッケージ情報。

## タスクと受け入れ条件

- [x] 既存要件・依存経路・公開勧告・修正版の実在を確認する。
- [x] 直接依存と必要な転移依存を更新する。
- [x] frozen lockfileから依存を導入し、GitHub警告の影響範囲と照合する。
- [x] cf-typegen、lint、typecheck、test、buildを実行する。
- [x] アプリコードに無関係な変更がないことをレビューし、PR用の検証結果を整理する。

## 検証結果

- `pnpm install --frozen-lockfile`：成功（pnpm 11.16.0 / Node 24.22.1）。
- `pnpm cf-typegen`：全7タスク成功。
- `pnpm -r --filter './packages/**' build` の後に `pnpm lint`：成功。
  公開型の出力先がdistのため、fresh checkoutではこの前処理が必要。
- `pnpm typecheck`：全14タスク成功。
- `pnpm test`：全11タスク成功、契約3件とドメイン5件が合格。
- `pnpm build`：全11タスク成功（Workers dry-runとNext.jsの本番ビルド）。
- 保存したGitHub警告50件とlockfileの版を照合し、影響範囲に残る版は0件。
- npm監査APIの呼び出しは未実施。未知の脆弱性や到達性を保証する結果ではない。
- Webに既存のworkers-typesとWranglerのpeer警告は残る。
  実際の型検査とdry-runは成功した。クラウドへの配置は行っていない。
