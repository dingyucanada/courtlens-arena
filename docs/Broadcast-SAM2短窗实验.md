# SAM2短窗可行性记录

2026-09-30。本实验不属于默认比赛关键路径，不宣称自动身份识别或完整48秒跟踪已完成。

使用已执行RF-DETR结果中的两个框作为提示，在同一镜头的16.0–16.8秒采样5帧，运行`transformers.Sam2VideoModel`与SAM2.1 Hiera Tiny。CPU运行记录5521毫秒。经联系图目视检查，两条目标框在该短窗基本贴合；未做人工像素标注或IoU评测。

- 原片SHA-256：`10dc5a80343dc97890fc89111fb40997565be2fe48732f815cb4af6902f7f24d`
- checkpoint：`facebook/sam2.1-hiera-tiny`，固定revision `de431c4043854a71d8101e17995dfe596bf101a5`
- 权重SHA-256：`48c14467e5cf9e51870511feb72c89688e82dd74523142c0538b663e193ac2a7`
- 实测环境：torch 2.14.0、transformers 5.17.0、OpenCV 4.14.0；这里记录版本，不自动安装重型依赖。
- 仅跟踪初始化时选中的对象；新入镜人物不会自动加入。切镜启发式不是可靠边界认证。
- 输出只含实际采样帧，不插值成25fps追踪；score继承检测种子，不能称跟踪概率。
- 无球衣OCR、姓名、球队身份、球场关键点或动作分类输出。

在已经准备依赖、合法素材和固定权重的环境中复现：

```sh
python tools/cv_sam2.py --video <source.mp4> --detections <executed-rfdetr-result.json> --checkpoint <local-checkpoint-directory> --start 16 --end 16.8 --max-objects 2 --fps 5 --output <new-result.json>
```

输入视频与检测结果hash必须一致。工具拒绝跨已知镜头、缺种子、超过6秒范围及非法数值。输出可作为待复核CV旁证，不自动批准任何战术或球员身份。权重不进入Git、容器或推理请求下载；正式采用前分别核查实现与权重许可。

参考：[Meta SAM2](https://github.com/facebookresearch/sam2)、[Transformers SAM2 Video](https://huggingface.co/docs/transformers/en/model_doc/sam2_video)。
