# teamx

pi上でエージェントチームを動かすCLI。チームごとにtool call・Skills・MCPの利用範囲を設定し、その範囲内で各エージェントへ割り当てます。共有タスクボード、個別メッセージ、チームチャンネル、レビューへの引き継ぎを備えます。

現段階はローカルCLI版です。Web UI、常駐デーモン、コンテナ隔離は含みません。

## 開発環境から起動

Node.js 24以降が必要です。リポジトリのルートで実行します。

```sh
npm ci --ignore-scripts
npm run hydrate:model-data
node apps/teamx/launch.mjs --help
node apps/teamx/launch.mjs init
```

プロキシ経由の環境では、モデル定義取得時に `NODE_USE_ENV_PROXY=1 npm run hydrate:model-data` を使用します。これはモデル一覧の取得で、推論APIの呼び出しではありません。

以降の `teamx` は `node /absolute/path/to/pi/apps/teamx/launch.mjs` を表します。`npm install --ignore-scripts` 後はリポジトリの `node_modules/.bin/teamx` からも起動できます。ソースリゾルバを使う開発版なので、現状はこのモノレポ内から利用してください。

## 認証と設定の保存先

ompと同様に、プロバイダー単位のログインと専用の設定保存先を持ちます。認証処理はpiの `ModelRuntime` を使用します。ompの `agent.db` とファイル形式を共有する実装ではありません。

```text
~/.teamx/
├── config.json                  # グローバルのチーム定義
└── agent/
    ├── auth.json                # プロバイダー認証（pi形式、所有者のみ読み書き）
    ├── models.json              # カスタムモデル・プロバイダー
    └── models-cache.json        # モデルキャッシュ

<project>/.teamx/
├── config.json                  # プロジェクトのチーム定義
├── skills/                      # 任意のSkill保存場所
└── state/                       # Git管理対象外
    ├── teamx.db                 # タスク・対話・実行履歴
    └── teams/<team>/
        ├── mcp-auth.json        # チーム専用MCP認証
        ├── mcp.log
        └── agents/<agent>/sessions/
```

`TEAMX_CONFIG_DIR` でグローバル保存先を変更できます。`.teamx/` は作業ディレクトリ直下のみを参照します。プロジェクトに同じIDのチームがある場合は、そのチーム定義全体でグローバル定義を置き換えます。別IDのグローバルチームは引き続き使えます。

pi/ompの設定・認証ファイルは自動移行・変更しません。プロバイダー標準の環境変数はpiの認証解決機構から利用できます。

```sh
teamx config path
teamx login <provider>
teamx models
teamx logout <provider>
```

OAuth対応プロバイダーではOAuthを優先します。APIキーでログインする場合は `teamx login <provider> api_key` とし、対話端末の非表示入力を使います。キーをコマンド引数へ渡す機能は設けていません。`models` の出力から `provider/model-id` を選び、各エージェントの `model` に指定してください。未指定の場合は利用可能なモデル一覧の先頭を使います。

## チーム → エージェントの設定

`teamx init` は開発チーム `dev` と `lead`・`builder`・`reviewer` を作成します。既存設定は上書きしません。`.teamx/config.json` を編集してチームや担当を追加できます。

```json
{
  "version": 1,
  "teams": {
    "dev": {
      "name": "開発チーム",
      "instructions": "依頼を分解し、実装後は別の担当がレビューする。",
      "tools": ["read", "edit", "write", "bash", "team_tasks", "team_messages", "team_handoff"],
      "skills": { "review": "skills/review/SKILL.md" },
      "mcp": {
        "github": {
          "config": { "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ${GITHUB_MCP_TOKEN}" } },
          "tools": ["get_issue", "list_pull_requests"]
        }
      },
      "defaults": {
        "tools": ["read", "team_tasks", "team_messages", "team_handoff"],
        "skills": [],
        "mcp": {}
      },
      "agents": {
        "lead": { "name": "Lead", "role": "タスクを分解し、担当を割り当てる" },
        "builder": {
          "name": "Builder",
          "role": "実装して結果を提出し、レビュアーへ引き継ぐ",
          "capabilities": { "tools": ["read", "edit", "write", "bash", "team_tasks", "team_messages", "team_handoff"] }
        },
        "reviewer": {
          "name": "Reviewer",
          "role": "変更をレビューし、承認または差し戻す",
          "capabilities": { "skills": ["review"], "mcp": { "github": ["get_issue"] } }
        }
      }
    }
  }
}
```

MCPのURL・ツール名は接続先が提供する実際の値を指定してください。上のツール名は構成を説明する例です。MCPの認証情報は環境変数参照を使い、設定ファイルへ平文で埋め込まないでください。実行履歴にはその実行で使った設定のスナップショットが保存されます。

- チームの `tools`・`skills`・`mcp` が利用可能な範囲です。
- `defaults` は新規エージェントなどへ継承する既定値です。省略した項目はチームの利用可能範囲全体になります。
- エージェントの `capabilities` は項目ごとに指定できます。未指定項目はチームの既定値を継承します。
- `tools: []`・`skills: []`・`mcp: {}` は、その項目を無効にします。
- 個別設定でチームの許可範囲を超えると、設定検証・実行開始時にエラーになります。
- Skillのパスは、そのチームを定義した `config.json` のあるディレクトリから解決します。
- MVPのMCP選択はサーバー単位・ツール単位です。ツール名は英数字とアンダースコア、または全許可の `*` を指定できます。MCP Resourcesは公開していません。

```sh
teamx config validate
teamx teams
teamx agents dev
```

モデル・指示・Skills・MCP接続設定は次のRunで読み直します。ツールの許可は実行開始時の設定と現在の設定の両方を満たす必要があり、実行中の権限取り消しも次のtool callから反映します。既に始まった外部操作を遡って取り消す機能ではありません。

## チームへの依頼と協調

```sh
teamx run dev lead "READMEを改善するタスクを作り、builderへ割り当て、reviewerへレビューを依頼して"
teamx work dev 10
teamx board dev
teamx messages dev
teamx runs dev
```

タスクの割り当てと宛先付きメッセージは、担当の受信キューへ入ります。`work` がキューを順番に処理し、エージェント間の引き継ぎも進めます。既定で最大10回、指定時は最大100回のRunで停止します。現在はチーム内を逐次実行します。エージェントごとの独立した `run` プロセスは並行起動できますが、同じエージェントの同時実行はDBで拒否します。

チームチャンネルへの投稿は全員を自動起動しません。対話が無制限に循環しないよう、担当者への通知を明示します。

```sh
teamx send dev builder "担当タスクを確認して"
teamx send dev all "APIの仕様を更新しました"
teamx chat dev lead
```

対話モードは `/board`・`/work`・`/exit` に対応します。各エージェントのpi会話履歴は次のRunに引き継ぎます。チーム内対話はローカル所有者が `messages` で確認できます。最終応答はチームチャンネルへ記録します。

## タスクと復旧

```text
ready → in_progress → review → done
                        └──差し戻し→ ready
実行失敗・中断 → blocked → 人間が確認してresume → ready
```

依存タスクが完了するまで取得できません。担当者だけが提出でき、別のエージェントか人間がレビューします。差し戻しと依存関係の解消も担当者に通知します。

```sh
teamx task add dev "ドキュメントを更新" builder
teamx task claim dev <task-id> builder
teamx task submit dev <task-id> builder "READMEを修正。成果物: README.md"
teamx task review dev <task-id> approve "内容を確認済み"
```

Ctrl-Cで実行を止められます。各Runには10分の上限があります。失敗・中断時は未処理メッセージを残し、担当の進行中タスクを `blocked` にします。クラッシュで残ったRunは、最後のheartbeatから60秒後に復旧できます。

```sh
teamx recover dev
teamx task resume dev <task-id>
teamx work dev
```

外部操作の実行後にクラッシュした場合、その操作は既に完了している可能性があります。再開前に実行履歴と成果物を確認してください。自動的なexactly-once実行は保証しません。

ツール権限はpiの実行経路で検査しますが、プロセスはOS上の同じユーザーで動きます。`read`・`bash`等によるファイルやネットワークへのアクセスはOSの権限に従います。チームの設定分離はコンテナや別ユーザーによる隔離ではありません。

## 検証

```sh
npm run test:unit --workspace teamx
npm run check --workspace teamx
npm run check
```

テストは一時ディレクトリとローカルのテストプロバイダー・MCPサーバーを使用します。実際のpiセッションでタスク作成、担当取得、提出、レビュー、MCP呼び出し、権限取り消しを確認し、推論APIは呼び出しません。
