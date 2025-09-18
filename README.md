# location3

国土数値情報 N05-24（鉄道時系列）をブラウザで確認できるシンプルな Web アプリケーションです。OpenStreetMap の地図タイル上に鉄道路線と駅を描画し、日付指定による時系列フィルタも利用できます。

## 使い方

```bash
go run ./cmd/webapp
```

- `-addr` でリッスンアドレスを変更できます（既定は `:8080`）。
- `-utf8-dir` に UTF-8 版データセットのディレクトリ（例: `N05-24_GML/UTF-8`）を渡せます。
- `-static-dir` で静的ファイルの配置ディレクトリを差し替えられます。

起動後、ブラウザで `http://localhost:8080/` を開くとマップが表示されます。

## データソースと権利表記

- 鉄道路線・駅データは、国土交通省 国土数値情報（鉄道時系列）N05-24 を使用しています。出典: [https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N05-2024.html](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N05-2024.html)
- 利用にあたっては必ず [国土数値情報利用約款](https://nlftp.mlit.go.jp/ksj/other/data_license.html) を遵守してください。本アプリケーションでは当該約款の「出典を明記すること」等の条件に従い、表示画面および README に利用データの出典を記載しています。
- 国土交通省が提供する原データに基づいていますが、アプリケーションの表示内容は独自に加工したものであり、国土交通省が保証するものではありません。

## 開発

```bash
go test ./...
```

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
