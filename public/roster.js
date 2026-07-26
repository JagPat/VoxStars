(function (root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.VoxRoster = value;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const ROSTER = Object.freeze([
    { no:149, name:'AR. Jagrut Patel', firm:'Vitan Architects', g:'M', pt:2, lgAvg:89, lgHigh:93, lgM:2, lgStr:null, lgSpr:null, role:'C' },
    { no:171, name:'Mr. Sandeep Sisodiya', firm:'Vox India', g:'M', pt:1, lgAvg:null, lgHigh:null, lgM:0, lgStr:null, lgSpr:null, role:'VC' },
    { no:175, name:'Mr. Siddharth Bhatt', firm:'Vox India', g:'M', pt:1, lgAvg:null, lgHigh:null, lgM:0, lgStr:null, lgSpr:null, role:'VC' },
    { no:99, name:'ID. Nayan Mistry', firm:'Hridgata Atelier', g:'M', pt:4, lgAvg:null, lgHigh:null, lgM:0, lgStr:null, lgSpr:null, role:'P' },
    { no:31, name:'ID. Shivangi Paradava', firm:'PDC Architects', g:'F', pt:7, lgAvg:115, lgHigh:158, lgM:3, lgStr:3, lgSpr:null, role:'P' },
    { no:22, name:'ID. Pranati Shah', firm:'PV Design Studio', g:'F', pt:10, lgAvg:121, lgHigh:152, lgM:4, lgStr:6, lgSpr:null, role:'P' },
    { no:114, name:'ER. Pratik Vasant', firm:'P.INE Studio', g:'M', pt:6, lgAvg:null, lgHigh:null, lgM:0, lgStr:null, lgSpr:null, role:'P' },
    { no:38, name:'AR. Akhil Gajjar', firm:'Verizon Architects', g:'M', pt:10, lgAvg:140, lgHigh:150, lgM:3, lgStr:10, lgSpr:null, role:'P' },
    { no:137, name:'Suraj Gajera', firm:'SV Design Interior', g:'M', pt:3, lgAvg:null, lgHigh:null, lgM:0, lgStr:null, lgSpr:null, role:'P' },
    { no:8, name:'AR. Sachi Prajapati', firm:'Verizon Architects', g:'F', pt:2, lgAvg:null, lgHigh:null, lgM:0, lgStr:null, lgSpr:null, role:'P' },
    { no:128, name:'AR. Saumil Patel', firm:'Squelette Design', g:'M', pt:4, lgAvg:165, lgHigh:177, lgM:2, lgStr:7, lgSpr:null, role:'P' },
    { no:41, name:'AR. Ankur Sanghvi', firm:'Tranquil Design Wave', g:'M', pt:4, lgAvg:133, lgHigh:145, lgM:3, lgStr:3, lgSpr:null, role:'P' },
    { no:49, name:'AR. Bhavik Nandi', firm:'Associated Architects', g:'M', pt:2, lgAvg:126, lgHigh:151, lgM:3, lgStr:5, lgSpr:null, role:'P' },
    { no:43, name:'AR. Arpan Patel', firm:'Briqmort', g:'M', pt:2, lgAvg:125, lgHigh:142, lgM:4, lgStr:6, lgSpr:null, role:'P' },
    { no:82, name:'AR. Karnav Patel', firm:'Satatya Architects', g:'M', pt:2, lgAvg:null, lgHigh:null, lgM:0, lgStr:null, lgSpr:null, role:'P' },
  ].map(p => Object.freeze(p)));
  const LEADS = Object.freeze({ A: 149, B: 171, C: 175 });
  return { ROSTER, LEADS };
});
