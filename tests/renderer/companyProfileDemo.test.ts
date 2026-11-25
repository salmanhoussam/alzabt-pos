import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {expect,it,vi} from "vitest";
const mode=vi.hoisted(()=>({demo:false}));
vi.mock("react",async(original)=>{
  const actual=await original<typeof import("react")>();
  return {...actual,useEffect:()=>{},useState:(initial:unknown)=>[initial===true?false:initial,()=>{}]};
});
vi.mock("../../src/renderer/demoMode",()=>({useDemoMode:()=>mode.demo}));
vi.mock("../../src/renderer/i18n",()=>({useT:()=>({t:(key:string)=>key})}));
import {CompanyProfileForm} from "../../src/renderer/screens/invoices/CompanyProfileForm";
it("hides unsupported Demo controls and retains editable shop identity",()=>{
  mode.demo=true;const html=renderToStaticMarkup(createElement(CompanyProfileForm,{}));
  expect(html).toContain('data-testid="company-name-ar"');
  expect(html).toContain('data-testid="company-logo-fixed"');
  for(const id of ['company-logo-choose','company-taxpayer','company-register','company-vat','company-tax-enabled','company-numbering-save'])
    expect(html).not.toContain('data-testid="'+id+'"');
  expect(html).not.toContain('inv.company.legalName');
});
it("retains existing real-shop controls",()=>{
  mode.demo=false;const html=renderToStaticMarkup(createElement(CompanyProfileForm,{}));
  for(const id of ['company-logo-choose','company-taxpayer','company-register','company-vat','company-tax-enabled','company-numbering-save'])
    expect(html).toContain('data-testid="'+id+'"');
  expect(html).toContain('inv.company.legalName');
  expect(html).not.toContain('data-testid="company-logo-fixed"');
});