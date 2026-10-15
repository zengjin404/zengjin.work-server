import{n as e,t}from"./TableModel-Dq6lotuu.js";import{t as n}from"./link-C0S9genM.js";import{t as r}from"./popconfirm-DbT2iX1e.js";import{$r as i,Ai as a,C as o,Fi as s,Jr as c,L as l,Qr as u,Ui as d,Ur as f,Vr as p,Yr as m,b as h,da as g,gi as _,k as v,l as y,m as b,ni as x,pi as S,si as C,tt as w,w as T}from"./index-CzybLgTJ.js";import E from"./班级管理_form-DL9bRy1_.js";var D={__name:`班级管理连选`,setup(D){S(()=>{A()});let O=s({}),k=s({data:[],rowKey:`id`,rowName:`name`,columns:[{ellipsis:!0,width:160,title:`班级名称`,colKey:`name`},{ellipsis:!0,width:120,title:`班主任`,colKey:`leader`},{ellipsis:!0,width:300,title:`班级口号`,colKey:`slogan`},{ellipsis:!0,width:160,title:`创建时间`,colKey:`createtime`},{ellipsis:!0,width:140,title:`操作`,colKey:`actions`,align:`center`,fixed:`right`}],pagination:{current:1,pageSize:20,total:0},onPageChange(e,t){k.pagination.current=e.current,k.pagination.pageSize=e.pageSize,M()},defaultSelectedRowKeys:[],onSelectChange(e,t){k.defaultSelectedRowKeys=e},activeRowType:`multiple`});function A(){k.pagination.current=1,M()}function j(){Object.keys(O).forEach(e=>delete O[e]),k.pagination.current=1,M()}function M(){b.get(`/api/zone/mzl/class/select`,{...O,current:k.pagination.current,pageSize:k.pagination.pageSize}).then(e=>{k.data=e.data||[],k.pagination.total=e.total||0})}s({});let N={row:{},action:``,dialog:!1,dialog_detail:!1,submitCallback(e){P.action===`insert`?A():M(),Object.assign(P,N)}},P=s({...N});function F(){P.row={},P.action=`insert`,P.dialog=!0}function I(e){P.row=e,P.action=`update`,P.dialog=!0}function L(e){P.row=e,P.action=`detail`,P.dialog=!0}function R(e){b.post(`/api/zone/mzl/class/delete`,{id:e.id}).then(e=>{l.success(e.msg),A()})}function z(){let e=h.confirm({header:`确定删除这${k.defaultSelectedRowKeys.length>1?k.defaultSelectedRowKeys.length:``}条数据？`,body:`请谨慎操作`,confirmBtn:{theme:`danger`},onConfirm:({e:t})=>{e.hide(),R({id:k.defaultSelectedRowKeys.join(`,`)})}})}return(s,l)=>{let h=v,b=T,S=e,D=w,M=o,N=n,B=r;return _(),m(f,null,[i(t,C(d(k),{show_checkbox:!1}),{TableModelHeader:a(()=>[i(M,{ref:`formRef`,data:d(O),layout:`inline`,colon:``,onKeypress:p(A,[`enter`])},{default:a(()=>[i(b,{label:`班级名称`},{default:a(()=>[i(h,{modelValue:d(O).name,"onUpdate:modelValue":l[0]||=e=>d(O).name=e,clearable:``},null,8,[`modelValue`])]),_:1}),i(b,{label:`班主任`},{default:a(()=>[i(h,{modelValue:d(O).leader,"onUpdate:modelValue":l[1]||=e=>d(O).leader=e,clearable:``},null,8,[`modelValue`])]),_:1}),i(b,{label:`建档日期`},{default:a(()=>[i(S,{modelValue:d(O).createtime,"onUpdate:modelValue":l[2]||=e=>d(O).createtime=e,clearable:``},null,8,[`modelValue`])]),_:1}),i(b,null,{default:a(()=>[i(D,{onClick:A},{default:a(()=>[...l[4]||=[u(`查询`,-1)]]),_:1}),i(D,{theme:`default`,variant:`outline`,onClick:j},{default:a(()=>[...l[5]||=[u(`重置`,-1)]]),_:1})]),_:1}),i(b,{toright:``},{default:a(()=>[i(D,{theme:`primary`,onClick:F},{default:a(()=>[...l[6]||=[u(`新增`,-1)]]),_:1}),i(D,{theme:`danger`,onClick:z,disabled:!d(k).defaultSelectedRowKeys.length},{default:a(()=>[...l[7]||=[u(`删除`,-1)]]),_:1},8,[`disabled`])]),_:1})]),_:1},8,[`data`])]),actions:a(({row:e})=>[i(N,{theme:`primary`,onClick:t=>L(e)},{default:a(()=>[...l[8]||=[u(`详情`,-1)]]),_:1},8,[`onClick`]),i(N,{theme:`warning`,onClick:t=>I(e)},{default:a(()=>[...l[9]||=[u(`编辑`,-1)]]),_:1},8,[`onClick`]),i(B,{theme:`danger`,content:`确定删除【${e[d(k).rowName]}】？`,onConfirm:t=>R(e)},{default:a(()=>[i(N,{theme:`danger`},{default:a(()=>[...l[10]||=[u(`删除`,-1)]]),_:1})]),_:1},8,[`content`,`onConfirm`])]),_:1},16),c(` <t-form ref="formRef" :data="form" layout="inline" colon @keypress.enter="click_select">
		<t-form-item label="班级名称">
			<t-input v-model="form.name" clearable />
		</t-form-item>
		<t-form-item label="班主任">
			<t-input v-model="form.leader" clearable />
		</t-form-item>
		<t-form-item label="建档日期">
			<t-date-picker v-model="form.createtime" clearable />
		</t-form-item>
		<t-form-item>
			<t-button @click="click_select">查询</t-button>
			<t-button theme="default" variant="outline" @click="click_reset">重置</t-button>
		</t-form-item>
		<t-form-item toright>
			<t-button theme="primary" @click="click_insert">新增</t-button>
			<t-button theme="danger" @click="click_deletes" :disabled="!table.defaultSelectedRowKeys.length">删除</t-button>
		</t-form-item>
	</t-form>

	<t-table
		:data="table.data"
		:columns="table.columns"
		:pagination="table.pagination"
		:onPageChange="table.onPageChange"
		activeRowType="multiple"
		v-model:activeRowKeys="table.activeRowKeys">
		<template #actions="{ row }">
			<t-link theme="primary" @click="click_detail(row)">详情</t-link>
			<t-link theme="warning" @click="click_update(row)">编辑</t-link>
			<t-popconfirm theme="danger" :content="\`确定删除【\${row[table.rowName]}】？\`" @confirm="click_delete(row)">
				<t-link theme="danger">删除</t-link>
			</t-popconfirm>
		</template></t-table
	> `),i(y,{visible:d(P).dialog,"onUpdate:visible":l[3]||=e=>d(P).dialog=e,width:450,header:{insert:`新增`,update:`${d(P).row[d(k).rowName]} - 编辑`,detail:`${d(P).row[d(k).rowName]} - 详情`}[d(P).action]},{default:a(()=>[i(E,g(x(d(P))),null,16)]),_:1},8,[`visible`,`header`])],64)}}};export{D as default};