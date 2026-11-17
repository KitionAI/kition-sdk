The editor installs the published `@kition/*` packages from npm at the versions the committed
`web/pnpm-lock.yaml` pins, so it needs no other checkout. To develop against
{{#linksTessera}}
kition-sdk and kition-tessera checkouts next to this repository (or the ones `KITION_SDK` and
`KITION_TESSERA` name), run `KITION_LINK=1 pnpm install` in `web/`; it links those checkouts'
packages and rewrites `web/pnpm-lock.yaml`, which must not be committed.
{{/linksTessera}}
{{^linksTessera}}
a kition-sdk checkout next to this repository (or the one `KITION_SDK` names), run
`KITION_LINK=1 pnpm install` in `web/`; it links that checkout's packages and rewrites
`web/pnpm-lock.yaml`, which must not be committed.
{{/linksTessera}}
