# location3

国土数値情報 N05-24（鉄道時系列）を使い、1950〜2024年の鉄道路線と駅を地図でたどる Web アプリケーション「鉄道の時間地図」です。スマホでは地図の下に年代操作をまとめ、検索と表示設定を折りたためます。

## 使い方

```bash
go run ./cmd/webapp
```

- `-addr` でリッスンアドレスを変更できます（既定は `:8080`）。
- `-utf8-dir` に UTF-8 版データセットのディレクトリ（例: `N05-24_GML/UTF-8`）を渡せます。
- `-static-dir` で静的ファイルの配置ディレクトリを差し替えられます。

起動後、ブラウザで `http://localhost:8080/` を開くとマップが表示されます。

### 地図の操作

- 初期表示はデータの最新年である **2024年**。スライダー、前後ボタン、年の直接入力、年代ショートカットで切り替えられます。
- 「全期間を見る」で全年代のデータを重ねて表示します。年代を変えても地図の位置・ズームを保ちます。
- 駅名・路線名を検索し、候補を選ぶと地図上へ移動します。検索対象は選択中の年代に存在するデータです。
- スマホでは「駅・路線を探す / 表示設定」を開くと、検索と路線・駅の表示切替を利用できます。
- 現在地ボタンは押したときだけブラウザに位置情報を要求します。HTTPS または localhost で利用できます。
- 「共有」で年代・地図位置・表示レイヤーを含むリンクを共有できます。端末が共有機能に対応していない場合はリンクをコピーできます。
- 地図の四隅アイコンで日本全体を表示します。キーボードの矢印キーでも地図や年スライダーを操作できます。

データの判定は**年単位**です。同じ年の中の開業・廃止日は区別しません。新しい共有URLは `?year=1980&lat=35.68&lng=139.76&zoom=12` の形式で、従来の `?date=1980-01-01` も読み込めます。全期間は `?year=all` です。年の選択範囲はデータの対象期間である1950〜2024年です。

地図ライブラリ（Leaflet）と背景地図（OpenStreetMap）は外部サービスから読み込みます。オフライン表示には対応していません。

## データソースと権利表記

- 鉄道路線・駅データは、国土交通省 国土数値情報（鉄道時系列）N05-24 を使用しています。出典: [https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N05-2024.html](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N05-2024.html)
- 利用にあたっては必ず [国土数値情報利用約款](https://nlftp.mlit.go.jp/ksj/other/data_license.html) を遵守してください。本アプリケーションでは当該約款の「出典を明記すること」等の条件に従い、表示画面および README に利用データの出典を記載しています。
- 国土交通省が提供する原データに基づいていますが、アプリケーションの表示内容は独自に加工したものであり、国土交通省が保証するものではありません。

## 開発

Go 1.25.1以降、JavaScriptのテストにはNode.js 22.18以降（TypeScriptの型消去に対応した版）を使用します。

```bash
go test ./...
npm test
```

追加のフロントエンドビルドは不要です。静的なHTML・CSS・ES ModulesをそのままGoサーバー／Workersから配信します。

| ファイル | 役割 |
| --- | --- |
| `web/static/index.html`, `styles.css` | レスポンシブな画面構成・スタイル |
| `web/static/app.mjs` | UIイベント、読み込み状態、検索・共有の操作 |
| `web/static/map.mjs` | Leaflet描画・ポップアップ・地図の操作 |
| `web/static/state.mjs` | URLの読み書きと入力値の検証 |
| `web/static/data.mjs` | API取得・キャンセル・直近2期間のキャッシュ・検索 |
| `internal/server/` | ローカルデータを配信するGoサーバー |
| `worker/` | R2データを配信するCloudflare Worker |
| `tests/`, `internal/server/testdata/` | フロントエンドのロジックテストと共通API fixture |

両バックエンドは `/api/railroads` と `/api/stations` のGET/HEADに対応します。`date=YYYY-MM-DD` を指定すると年単位で絞り込み、未指定なら全件を返します。存在しない日付は400です。駅は当該年の路線名でも絞り込みます。Workerの年別応答キャッシュは最大3件・推定8MiBまでで、大きい応答はキャッシュしません。

ブラウザでは年代変更時に古いリクエストを中断し、描画を小分けにして操作を妨げにくくしています。取得失敗時は地図内に再試行ボタンを表示します。

Pull Request では `go test` の結果や使用した追加ツールがあれば明記してください。

## Cloudflare Workers へのデプロイ

このリポジトリには Cloudflare Workers にそのままデプロイできる設定も含めています。Workers 上でフロントエンドを配信し、R2 に配置した GeoJSON を API として提供します。

1. [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) をインストールし、`wrangler login` でアカウントに接続します。
2. Cloudflare ダッシュボードまたは `wrangler r2 bucket create location3-data` で R2 バケットを作成します（`wrangler.toml` の `bucket_name` と一致させてください）。
3. 鉄道路線と駅の GeoJSON をバケットにアップロードします。
   ```bash
   wrangler r2 object put location3-data/N05-24_RailroadSection2.geojson --file N05-24_GML/UTF-8/N05-24_RailroadSection2.geojson
   wrangler r2 object put location3-data/N05-24_Station2.geojson --file N05-24_GML/UTF-8/N05-24_Station2.geojson
   ```
4. 必要に応じて `wrangler.toml` の `name` や `bucket_name`、`preview_bucket_name` を編集します。静的アセットは `[assets]` セクションで `binding = "ASSETS"`、`directory = "web/static"` と定義しているので、構成を変えるときは合わせて更新してください。カスタムドメインで公開する場合は `[[routes]]` の `pattern` を任意のドメイン名（例: `l3.example.com`）に書き換え、Cloudflare 側でそのドメインをゾーンに追加しておきます。
5. `wrangler deploy`（または `make deploy-worker`）を実行すると、`web/static` のアセットが配信され、`/api/railroads` と `/api/stations` が Worker 経由で R2 のデータを提供します。デプロイ後 `wrangler tail` や Cloudflare ダッシュボードのログで動作を確認してください。ブラウザ側では日付・レイヤートグル・地図表示範囲を URL クエリに埋め込むので、必要に応じてそのまま共有できます。

### よく使う Wrangler コマンド

`Makefile` にラッパーターゲットを用意しています。

```bash
# Worker のローカルプレビュー
make worker-dev

# 本番デプロイ
make deploy-worker
```

Workers 上での利用時も、国土数値情報利用約款と OpenStreetMap のクレジット表記を忘れずに行ってください。
