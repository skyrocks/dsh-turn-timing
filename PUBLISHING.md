# 发布清单（维护者用）

这份文件不会随 tarball 发布，只用于把仓库整理成可公开的状态。

## 1. 发布前检查

```sh
node test/smoke.mjs       # 纯计算回归，9 组归类 + 折叠 + 识图 + 配对
node --check client.js    # 语法
node --check index.js
```

- [ ] 版本号与 `CHANGELOG.md` 对应
- [ ] `README.md` / `README.en.md` 的截图与当前界面一致
- [ ] `package.json` 的 `repository` / `homepage` / `bugs` 指向 `skyrocks/dsh-turn-timing`
- [ ] `dsh.engines` 与目标 DSH 版本匹配

## 2. 本地安装自测

在 `~/.dsh/profiles/desktop/package.json` 里加 `link:` 依赖与 bundle，`pnpm install`，完全退出重启，
确认每轮末尾出现那一行。

## 3. 打包

```sh
pnpm pack     # 生成 skyrocks-dsh-turn-timing-0.1.8.tgz
```

## 4. 发布

```sh
git push -u origin main
git push origin v0.1.8
gh release create v0.1.8 ./skyrocks-dsh-turn-timing-0.1.8.tgz \
  --title "v0.1.8" --generate-notes
```

## 5. 可选：发布到 npm

```sh
npm publish --access public
```

包名 `@skyrocks/dsh-turn-timing`，发布前确认 scope 有权限且 npm 上无同名包。

## 6. 截图怎么更新

`docs/preview-*.svg` 是源文件，`preview-*.png` 由它渲染：

```sh
rsvg-convert -z 2 -o docs/preview-expanded.png docs/preview-expanded.svg
```

有真机截图时，直接替换对应 PNG 并把 README 里的「示意图」说明删掉。
