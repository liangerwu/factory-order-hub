# 联单 · 订单协同管理系统

Node.js 24+，无第三方 npm 依赖。业务、财务、美工、车间、仓库按岗位协作。

## 初始化及启动

```sh
node configure-admins.mjs
npm start
```

初始化工具交互录入3个管理员手机号和初始密码（密码隐藏输入），本地生成 deploy/initial-admins.json，仅含加盐哈希；此文件不得提交Git。首次登录强制改密。重启不重置账号，不接受已有数据的隐式初始化。默认监听127.0.0.1:4318，正式使用须配置HTTPS反向代理。

## 数据单独保管

此仓库不包含真实手机号、密码哈希、订单、图片、数据库、收款账户或产品资料。需要现有9986条产品资料时，从单独交付的部署包复制 deploy/products.json 到服务器，不提交Git。数据存储于data/order-hub.sqlite，应使用SQLite在线备份或停机备份完整data目录。

## 面单识别

macOS依赖Apple Vision及xcrun swiftc；Linux/Windows自动识别尚待适配，可上传图片并人工填写物流信息。不要将当前版本描述为全功能跨平台OCR版本。
