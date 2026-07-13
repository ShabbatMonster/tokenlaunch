#!/bin/sh
# Deploys LaunchFactory to Robinhood Chain mainnet with the gitignored
# deployer key. Fee recipient: 0xbE8a...04dA. TESTING config: owner = deployer
# (so the fee split can be tweaked without the main wallet), 100% protocol fee,
# 0 launch fee, ~1.3556 ETH starting pool valuation.
# Hand ownership to 0xbE8a...04dA when testing is done:
#   cast send <factory> "transferOwnership(address)" 0xbE8a...04dA --private-key <deployer>
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
    0xB74e3dB876A07aEA1cC1048C1058a15b834dDcFa \
    0xbE8af7E12B536aB55fbaf92EDbb512972e0504dA \
    10000 \
    1355600000000000000
