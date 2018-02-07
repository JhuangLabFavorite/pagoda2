"use strict";

self.collectedResults = [];
self.geneName = null;
self.selAidx = null;
self.selBidx = null;
self.method = null;
self.chunks = 20;
self.minchunksize = 500;

// Main event listener for the worker thread
self.addEventListener("message", function(e){
  var callParams = e.data;

  if(callParams.type === "initiate"){
    handleInitiateCommand(e);
  } else if(callParams.type === "process"){
    handleProcessCommand(e);
  }

},false);

function handleInitiateCommand(e) {
    self.geneNames = e.data.params.geneNames;
    self.method = e.data.method;
    e.data.params.geneNames = null;

    var callParams = e.data;

    callParams.params.step = Math.max(Math.floor(self.geneNames.length/self.chunks),self.minchunksize);
    callParams.params.index = 0;
    callParams.params.numCells = callParams.data.length;

    //if there is only one selection given make the second selection off of the indexes of the cellOrderData keys
    if(callParams.selections.length === 1){
      // Only one selection
      self.selAidx = [];
      self.selBidx = [...callParams.data.keys()];
      //creates array of cell indexes based on their corresponding index in cell order array
      for(var i = 0; i < callParams.selections[0].length; i++){
        var idx = callParams.data.indexOf(callParams.selections[0][i]);
        if(idx !== -1){
          self.selAidx.push(idx);
        }
      }
    } else if(callParams.selections.length === 2){
      // Two selections
      self.selAidx = [];
      self.selBidx = [];
      for(var i = 0; i < callParams.selections[0].length; i++){
        var idx = callParams.data.indexOf(callParams.selections[0][i]);
        if(idx !== -1){
          self.selAidx.push(idx);
        }
      }
      for(var i = 0; i < callParams.selections[1].length; i++){
        var idx = callParams.data.indexOf(callParams.selections[1][i]);
        if(idx !== -1){
          self.selBidx.push(idx);
        }
      }
    }

    var nextSliceGenes = self.geneNames.slice(
          callParams.params.index,
          Math.min(callParams.params.index + callParams.params.step,self.geneNames.length)
    );

    postMessage({
        type: "expr vals",
        data: nextSliceGenes,
      params: callParams.params
    });
}

function handleProcessCommand(e) {
  var callParams = e.data;
  if(self.method === "wilcoxon"){
    runMannWhitneyIteration(callParams.params, callParams.data);
  } else {
    // TODO: Handle error
  }

  //advance index to current spot
  callParams.params.index += callParams.params.step;

  //continue requesting data if data still needs to be read
  if(callParams.params.index < self.geneNames.length){
    var nextGeneNames = self.geneNames.slice(callParams.params.index,
          Math.min(callParams.params.index + callParams.params.step, self.geneNames.length));

    postMessage({
        type: "expr vals",
        data: nextGeneNames,
      params: callParams.params
    })
  } else {
    postMessage({
      type: "complete",
      results: self.collectedResults,
      params: callParams.params
    })
  } // if.. else if(callParams.params.index < callParams.params.geneNames.length)
}

/**
 * Calculate differential expression between two groups of cells the Wilcoxon Mann-Whitney test
 * @param params A compound object containing data, and information passed to this worker from the event listener
 * @param geneData A sparse matrix containing the gene names being read in and the expression values
 */
function runMannWhitneyIteration(params, geneData){

      for(var geneindex = 0; geneindex < geneData.array[0].length; geneindex++){

        var allValues = [];

        var nNonZeroA = 0;
        var nNonZeroB = 0;

        // Skip sparse genes
        var sparseFractionCutoff = 0.10;

        //retrieve expression data by indexes for selection A
        for(var cell = 0; cell < self.selAidx.length; cell++){
          var eVal = geneData.array[self.selAidx[cell]][geneindex];
          if (eVal != 0) nNonZeroA++;
          allValues.push({
            selection: 1,
            exprVal: eVal
          });
        }
        if(nNonZeroA < self.selAidx.length * sparseFractionCutoff) continue;

        //retrieve expression data by indexes for selection B
        for(var cell = 0; cell < self.selBidx.length; cell++){
          var eVal = geneData.array[self.selBidx[cell]][geneindex];
          if (eVal != 0) nNonZeroB++;
          allValues.push({
            selection: 2,
            exprVal: eVal
          });
        }
        if(nNonZeroB < self.selBidx.length * sparseFractionCutoff) continue;

        // Sort and calculate total ranks
        allValues.sort(function(x,y){return x.exprVal - y.exprVal});

        // For keeping track of ties
        var lastVal = allValues[0].exprVal;
        var lastValStartIndex = 0;
        var inTie = false;

        // Calculate element ranks taking into account ties
        for (var i = 0; i < allValues.length; i++) {
          // Set the rank to the position in the array (1-indexed)
          allValues[i].rank = i + 1;

          if (allValues[i].exprVal === lastVal) {
            // In a tie
            if (!inTie) {
              // Just entered the tie
              lastValStartIndex = i;
              lastVal = allValues[i].exprVal;
              inTie = true;
            }
            // else we were already in a tie and we don't need to do anything
          } else {
            // Not in a tie
            if (inTie) {
              // Just exited the previous tie
              var commonRank = (lastValStartIndex + 1) + (i + 1) / (i - lastValStartIndex + 1);
              for (var j = lastValStartIndex; j < i; j++) {
                allValues[j].rank = commonRank;
              } // for

              inTie = false;
            } else { // Not in tie
              lastVal = allValues[i].exprVal;
              lastValStartIndex = i;
            } // if inTie
          } // if == lastVa else
        } // for i

        // Calculate rank sum for A
        var totalRankA = 0;
        for (var i = 0; i < allValues.length; i++) {
          if (allValues[i].selection === 1){
            totalRankA += (i+1);
          }
        }

        // Calculate U values
        var lengthA = self.selAidx.length;
        var lengthB = self.selBidx.length;
        var lenghtAxlengthB = lengthA * lengthB; //u1u2
        var u1 = totalRankA - (lengthA * (lengthA +1)) /2;
        var u2 = lenghtAxlengthB - u1;
        var U = Math.min(u1, u2);

        // Perform Normal approximation with tie correction
        var muU = lenghtAxlengthB / 2;

        // Calculate rank abundance and Loop over rank counts and calculate K
        var rankCounts = {};
        for (var i = 0; i < allValues.length; i++) {
          var rank = allValues[i].rank;
          if(typeof rankCounts[rank] === 'undefined') {
            rankCounts[rank]= 1;
          } else {
            rankCounts[rank] = rankCounts[rank] + 1;
          }
        }
        var K = 0;
        var n = lengthA + lengthB;
        var ranks = Object.keys(rankCounts);
        for (var i = 0; i < ranks.length; i++) {
          var ti = rankCounts[ranks[i]];
          K = K + ( (Math.pow(ti,3) - ti) / (n * (n-1) ) );
        }

        // Calculate corrected sigma
        var sigmaUcorr = Math.sqrt( lenghtAxlengthB / 12 * ( n + 1 ) - K);

        // Calculate corrected Z score
        var z = (U - muU) / sigmaUcorr;

        const zcutoff = 4.0;
        var zAbs = Math.abs(z);
        if(zAbs >= zcutoff){
          // TODO: Calculate fe and M

          var sumA = 0;
          var nA = self.selAidx.length;
          for(var cell = 0; cell < nA; cell++){
            sumA += geneData.array[self.selAidx[cell]][geneindex];
          }
          var meanA = sumA / nA;

          var sumB = 0;
          var nB = self.selBidx.length;
          for(var cell = 0; cell < nB; cell++){
            sumB += geneData.array[self.selBidx[cell]][geneindex];
          }
          var meanB = sumB /nB;

          self.collectedResults.push(
            {
              Z: z,
              absZ: zAbs,
              name: geneData.colnames[geneindex],
              fe: Math.log(meanA/meanB)/ Math.log(10),
              M: (sumA+sumB)/(nA+nB),
              highest: false
            }
          )
        } // zAbs >= zcutoff

      }
}