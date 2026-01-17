-- Source: Wintermute research (via Dune query)
-- https://dune.com/queries/5145294
--
-- NOTE: This file stores the label mapping locally for convenience. Treat as advisory; labels may be
-- incomplete or incorrect. The authoritative source is the Dune query above.

WITH custom_labels (address, name, category) AS (
  VALUES
    ('0xcda3577ca7ef65f6b7201e9bd80375f5628d15f7', 'WhiteBIT', 'Service'),
    ('0x79Cf9e04aD9aeB210768c22c228673aED6Cd24C4', 'WhiteBIT', 'Service'),
    ('0x4b3a543dc60a09974007d6937cd952e3a0188929', 'WhiteBIT', 'Service'),
    ('0x0000000000000000000000000000000000000000', 'Revoked Delegations', 'Revoked Delegations'),
    ('0x80296ff8d1ed46f8e3c7992664d13b833504c2bb', 'OKX Wallet', 'Retail Wallets'),
    ('0x63c0c19a282a1b52b07dd5a65b58948a07dae32b', 'Metamask', 'Retail Wallets'),
    ('0x5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d', 'Ambire', 'Retail Wallets'),
    ('0x4428a93B478fa76A5BD9c7641F54EC6373855433', 'Bitget', 'Retail Wallets'),
    ('0xa845C74344Fc9405b1Fcf712f04668979573c1bf', 'Bitget', 'Retail Wallets'),
    ('0x0c338ca25585035142A9a0a1EEebA267256f281f', 'Uniswap', 'Retail Wallets'),
    ('0x458f5a9f47A01beA5d7A32662660559D9eD3312c', 'Uniswap', 'Retail Wallets'),
    ('0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00', 'Uniswap', 'Retail Wallets'),
    ('0x000000004F43C49e93C970E84001853a70923B03', 'Biconomy', 'Retail Wallets'),
    ('0x00000000383e8cBe298514674Ea60Ee1d1de50ac', 'Biconomy', 'Retail Wallets'),
    ('0x69007702764179f14F51cdce752f4f775d74E139', 'Alchemy', 'Retail Wallets'),
    ('0xbaC7e770af15d130Cd72838ff386f14FBF3e9a3D', 'Thirdweb', 'Retail Wallets'),
    ('0xD6999651Fc0964B9c6B444307a0ab20534a66560', 'Thirdweb', 'Retail Wallets'),
    ('0x173217d7f8c26Dc3c01e37e1c04813CC7cC9fEc2', 'Thirdweb', 'Retail Wallets'),
    ('0x4670D851672Cb6E3ab4FaEA0a18dc08eDeA01d5E', 'Thirdweb', 'Retail Wallets'),
    ('0xd6CEDDe84be40893d153Be9d467CD6aD37875b28', 'ZeroDev', 'Retail Wallets'),
    ('0xe6cae83bde06e4c305530e199d7217f42808555b', 'Simple7702Account (Pimlico, ...)', 'Retail Wallets'),
    ('0x664ab8c20b629422f5398e58ff8989e68b26a4e6', 'Porto', 'Retail Wallets'),
    ('0x8c0466A6C046395c8999227b288883cf7dC9f5de', 'Porto', 'Retail Wallets'),
    ('0xB292da8879c26ECd558BBEa87f581Cdd608FFc3c', 'Porto', 'Retail Wallets'),
    ('0x5874F358359ee96d2b3520409018f1a6F59A2CDC', 'Porto', 'Retail Wallets'),
    ('0x23E5F9C457A69Ce776d20A8fe812A6701D66fcE8', 'Otim', 'Retail Wallets'),
    ('0xb15Bed8FC30D3E82672bF7cD75417B414983934B', 'SafePal', 'Retail Wallets'),
    ('0x5aF42746a8Af42d8a4708dF238C53F1F71abF0E0', 'Gelato', 'Retail Wallets'),
    ('0x7702cb554e6bFb442cb743A7dF23154544a7176C', 'Coinbase Wallet', 'Retail Wallets'),
    ('0xD2e28229F6f2c235e57De2EbC727025A1D0530FB', 'Trust Wallet', 'Retail Wallets'),
    ('0xcc0c946EecF01A4Bc76Bc333Ea74CEb04756f17b', 'TokenPocket', 'Retail Wallets'),
    ('0x0000FB7702036FF9F76044A501AC1AA74CBAB16B', 'Fireblocks', 'Custody'),
    ('0x7785a22Facd31dB653bA4928f1D5B81D093f0b2f', 'Cordial', 'Custody'),
    ('0xcEa43594f38316F0e01c161D8DaBDe0a07a1F512', 'Dfns', 'Custody'),
    ('0x411d38d27f6F2c7F3B70FF29DAda64cbD7BFa9b2', null, 'MEV'),
    ('0x4884d28F048E66A537762334937e01A044CbDFAc', null, 'MEV'),
    ('0x73a10A2b222fE41997b58059DA2163Bfe663A682', null, 'MEV'),
    ('0x5d6EBDDD42f3668073b2707b763A201872d6Eca0', 'BatchExecutor', null),
    ('0xF6AE00D4C8605133D756858D8F2D8FC51214C1F3', 'TokenSender', null),
    ('0x4A70C8E1A4319aB5aE982e96ECcC1abB8CFFa7eF', 'TokenSender', null),
    ('0xcA11bde05977b3631167028862bE2a173976CA11', 'Multicall3', null),
    ('0x00000000BEBEDB7C30ee418158e26E31a5A8f3E2', 'BasicEOABatchExecutor', null),
    ('0x775c8D470CC8d4530b8F233322480649f4FAb758', 'BatchCallAndSponsor', null),
    ('0x02E34e8c40A2A80AB96453455C1C6452317abfe6', 'EIP7702ArbitrageExecutorV2', null)
)
SELECT * FROM custom_labels;

