async function getBaseFeeGwei() {
  const rpcUrl = "https://cronos.blockpi.network/v1/rpc/8c000aa3c116d991def800b5baf5193372ca0445";
  
  const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBlockByNumber",
      params: ["latest", false]
  };

  try {
      const response = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
      });

      const data = await response.json();
      
      if (data.result && data.result.baseFeePerGas) {
          const baseFeeWei = BigInt(data.result.baseFeePerGas);
          console.log(`Base Fee: ${baseFeeWei} Wei`);
          const baseFeeGwei = baseFeeWei / BigInt(1e9); // Convert Wei to Gwei
          console.log(`Base Fee: ${baseFeeGwei} Gwei`);
          return baseFeeGwei;
      } else {
          console.error("Base fee not found in response.");
          return null;
      }
  } catch (error) {
      console.error("Error fetching base fee:", error);
      return null;
  }
}

// Call the function
getBaseFeeGwei();
