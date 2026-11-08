# The demo stack's database (owner 1405/08/07): the tested image, plus libfaketime so the demo
# seed can write six months of history through the real services (no injectable clock in
# the code). Demo only; never staging or production. The package is fetched at build time.
FROM postgres:17-alpine@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995
RUN apk add --no-cache libfaketime
