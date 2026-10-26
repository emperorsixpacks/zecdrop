// The example payout list the payouts screen offers in practice mode: the same file the home page's lens shows and the real
// testnet run was made from (examples/demo-recipients.testnet.csv). Its addresses are testnet addresses published in this
// repository, so nothing in it is anyone's private data.

import list from "../../../examples/demo-recipients.testnet.csv?raw";

export const EXAMPLE_LIST: string = list;
