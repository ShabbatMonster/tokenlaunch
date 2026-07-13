#!/bin/sh
# Deploys LaunchFactory to Robinhood Chain mainnet with the gitignored
# deployer key. Owner + protocol fee recipient: 0xbE8a...04dA, 1% fee share,
# 0 launch fee, ~1.3556 ETH starting pool valuation (matches RobinFun curve).
set -e
FORGE="${FORGE:-forge}"
PK=$(head -1 deployer.key)
"$FORGE" create contracts/LaunchFactory.sol:LaunchFactory \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --private-key "$PK" \
  --broadcast \
  --constructor-args \
    0x1f7d7550B1b028f7571E69A784071F0205FD2EfA \
    0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 \
    0xbE8af7E12B536aB55fbaf92EDbb512972e0504dA \
    0xbE8af7E12B536aB55fbaf92EDbb512972e0504dA \
    100 \
    1355600000000000000
