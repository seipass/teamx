# teamx

piを基盤に、チームごとのtool call・Skills・MCPと、所属エージェントごとの役割・能力を設定するローカルCLIです。共有タスクボード、チーム内対話、担当への通知、レビューへの引き継ぎを実装しています。

```sh
node apps/teamx/launch.mjs init
node apps/teamx/launch.mjs config validate
node apps/teamx/launch.mjs board dev
```

認証は専用の `~/.teamx/agent/`、プロジェクト設定と状態は `.teamx/` に保存します。

セットアップ・認証・設定例・利用方法は [teamx README](apps/teamx/README.md) を参照してください。
